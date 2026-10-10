// D43: a job that fails for the platform's reasons is refunded; one that fails for the team's keeps its
// charge (D19), so failing never buys a team more than its budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type LedgerRow, ourFailure, recordProgress, spent } from "../src/ledger.ts";

const row = (id: string, kind: string, cost: string): LedgerRow =>
	({ id, kind, cell: "01", take: "", attempt: "1", group: "", status: "running", detail: "", result: "", updated: "", cost_est: cost }) as LedgerRow;

test("D43: our failures are refunded, with the reason in the job's detail", () => {
	// The rehearsal: a clip rendered and charged, then refused on a branch we had numbered wrong
	const rows = [row("a", "video", "0.1700"), row("b", "take", "0.0550")];
	recordProgress(rows, "a", { status: "failed", detail: "PushRejectedError: Push rejected because it was not a simple fast-forward.", now: "t" });
	assert.equal(rows[0].cost_est, "0");
	assert.match(rows[0].detail, /\(refunded \$0\.17: a branch conflict on our side\)$/);
	assert.equal(spent(rows), 0.055);
	recordProgress(rows, "b", { status: "failed", detail: "interrupted; retake from the board", now: "t" });
	assert.equal(spent(rows), 0);
});

test("D43: the team's own failures keep their charge", () => {
	const rows = [row("a", "video", "0.1700")];
	// A model that refuses the team's frame, a prompt that's flagged: the team chose them
	recordProgress(rows, "a", { status: "failed", detail: "AiGatewayError: 7003: User Input Error", now: "t" });
	assert.equal(rows[0].cost_est, "0.1700");
	assert.equal(ourFailure("3030: flagged as sensitive content"), undefined);
});

test("D43: every platform failure seen in a ledger is recognised", () => {
	for (const detail of [
		"stalled: no progress for 10 minutes",
		"AiGatewayError: 3040: Capacity temporarily exceeded",
		"3043: out of capacity",
		"AiGatewayError: 3021: rate limited",
		"AiGatewayError: 2021: Insufficient AI Gateway credits/balance",
		"downloading the clip failed: 502",
	]) assert.ok(ourFailure(detail), detail);
	// A refund is applied once: a job already refunded has nothing left to release
	const rows = [row("a", "take", "0")];
	recordProgress(rows, "a", { status: "failed", detail: "interrupted", now: "t" });
	assert.equal(rows[0].detail, "interrupted");
});
