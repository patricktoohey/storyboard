// D46: a round can start from any commit on a board's main, as if what followed hadn't happened.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existedAt, findOnMain } from "../src/versions.ts";

// main, newest first: a print at t=300, the commit to start from at t=200, the plan at t=100
const main = [
	{ hash: "c300aaaaaaaa", authoredAt: 300 },
	{ hash: "c200bbbbbbbb", authoredAt: 200 },
	{ hash: "c100cccccccc", authoredAt: 100 },
];
const hashes = new Set(main.map((c) => c.hash));

test("D46: a start commit is found on main by its id or a prefix of 7 or more", () => {
	assert.deepEqual(findOnMain(main, "c200bbb"), { index: 1, commit: main[1] });
	assert.equal(findOnMain(main, "c200bbbbbbbb")?.index, 1);
	assert.equal(findOnMain(main, "c200b"), undefined);
	assert.equal(findOnMain(main, "deadbeef"), undefined);
});

test("D46: a branch existed at the commit if one of its own commits is that old", () => {
	// A take shot before the commit, and inspected after it on the next round: it existed
	assert.equal(existedAt([{ hash: "t-inspect", authoredAt: 400 }, { hash: "t-render", authoredAt: 150 }, main[2]], hashes, 200), true);
	// A take or a cut made after the commit didn't, though its history holds main's older commits
	assert.equal(existedAt([{ hash: "t-render", authoredAt: 250 }, main[1], main[2]], hashes, 200), false);
	// A saved version is main as it was: it existed if what it points at is that old
	assert.equal(existedAt([main[1], main[2]], hashes, 200), true);
	assert.equal(existedAt([main[0], main[1], main[2]], hashes, 200), false);
	assert.equal(existedAt([], hashes, 200), false);
});
