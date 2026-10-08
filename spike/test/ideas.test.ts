// Ideas for one shot in parallel (D35): two or three named ideas, each its own take branch; rivals see
// that a team tried ideas, not what they are; every idea counts as a Git move.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardSummary, allowedActions, parseDecision, parseIdeas } from "../src/arena-rules.ts";
import { publicMove } from "../src/format-rules.ts";
import { gitMoves } from "../src/process-rules.ts";

const s = {
	drafted: true,
	planned: true,
	planRequested: true,
	cells: [{ id: "01", printed: 1, takes: [] }, { id: "03", printed: 1, takes: [] }],
	cutRunning: false,
	submitted: false,
	openJobs: 0,
	spent: 0.5,
	budget: 5,
	now: 0,
	deadline: 20 * 60_000,
	cutSeconds: 10,
	prices: { take: 0.03, turn: 0.005, cut: 1.0 },
} as unknown as BoardSummary;

test("D35: ideas need a shot and two or three named ideas; names become slugs and stay distinct", () => {
	assert.deepEqual(parseIdeas([{ name: "The Mirror", idea: "Her face, the empty seat in the mirror" }, { name: "the mirror", idea: "Through the windshield" }, { idea: "From the back seat" }, { name: "x", idea: "a fourth" }]), [
		{ name: "the-mirror", text: "Her face, the empty seat in the mirror" },
		{ name: "the-mirror-2", text: "Through the windshield" },
		{ name: "idea-3", text: "From the back seat" },
	]);
	const d = parseDecision('{"action": "ideas", "args": {"cell": 3, "ideas": [{"name": "mirror", "idea": "a"}, {"name": "profile", "idea": "b"}]}, "reason": "shot 3 isn\'t working"}', ["ideas"], s);
	assert.deepEqual(d, { action: "ideas", args: { cell: "03", ideas: [{ name: "mirror", text: "a" }, { name: "profile", text: "b" }] }, reason: "shot 3 isn't working" });
	assert.ok("error" in parseDecision('{"action": "ideas", "args": {"cell": "03", "ideas": [{"name": "one", "idea": "only"}]}}', ["ideas"], s));
});

test("D35: two ideas cost two takes, and never the money the video needs", () => {
	assert.ok(allowedActions(s).includes("ideas"));
	// $1.00 of video and two $0.03 takes don't fit in what's left
	assert.ok(!allowedActions({ ...s, spent: 3.96 } as BoardSummary).includes("ideas"));
});

test("D35: rivals see how many ideas, not what they are; each idea round is a Git move", () => {
	assert.equal(publicMove("ideas", { cell: "03", ideas: [{ name: "mirror", text: "secret" }, { name: "profile", text: "secret" }] }), "shot 2 ideas for cell 03");
	assert.deepEqual(gitMoves([{ detail: 'turn 5: ideas (opus) on cell 03: "mirror", "profile"', result: "acted" }]), { total: 1, ideas: 1 });
});
