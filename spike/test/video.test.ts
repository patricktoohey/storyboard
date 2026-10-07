// D17: frames reach the video provider through signed, expiring URLs that grant one frame and nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { clipSeconds, frameUrl, motionPrompt, verifyFrame } from "../src/video.ts";

const env = { SPIKE_KEY: "test-key" } as Env;
const origin = "https://storyboard.example";

test("D17: a signed frame URL verifies and grants exactly that frame", async () => {
	const url = new URL(await frameUrl(env, origin, "board-x", "abc123", "cells/02/frame.webp"));
	assert.equal(url.pathname, "/public/frame.jpg");
	assert.deepEqual(await verifyFrame(env, url), { repo: "board-x", ref: "abc123", path: "cells/02/frame.webp" });
});

test("D17: tampering with any part of a signed URL voids it", async () => {
	const signed = await frameUrl(env, origin, "board-x", "abc123", "cells/02/frame.webp");
	for (const [k, v] of [["repo", "board-y"], ["ref", "main"], ["path", "cells/03/frame.webp"], ["exp", "9999999999"]]) {
		const url = new URL(signed);
		url.searchParams.set(k, v);
		assert.equal(await verifyFrame(env, url), null, `changed ${k}`);
	}
	assert.equal(await verifyFrame({ SPIKE_KEY: "other-key" } as Env, new URL(signed)), null, "other key");
});

test("D17: signed URLs expire, and only ever grant cell frames", async () => {
	const url = new URL(await frameUrl(env, origin, "board-x", "abc123", "cells/02/frame.webp"));
	url.searchParams.set("exp", "1000");
	assert.equal(await verifyFrame(env, url), null, "expired");
	// Even a correctly signed URL for another file is refused
	const notAFrame = new URL(await frameUrl(env, origin, "board-x", "main", "characters.json"));
	assert.equal(await verifyFrame(env, notAFrame), null);
});

test("clips follow the cell's planned duration, within 2 s and the cost cap", () => {
	assert.equal(clipSeconds({ duration_s: 10 }, 5), 5);
	assert.equal(clipSeconds({ duration_s: 1 }, 5), 2);
	assert.equal(clipSeconds({ duration_s: 3.6 }, 5), 4);
	assert.equal(clipSeconds({ duration_s: Number.NaN }, 5), 3);
});

test("the motion prompt says what moves; the frame already fixes the look", () => {
	assert.match(motionPrompt({ beat: "She rows out.", camera: "static", shot: "WS" }), /^She rows out\. The camera stays still\./);
	assert.match(motionPrompt({ beat: "He turns.", camera: "slow push-in", shot: "CU" }), /Camera: slow push-in\./);
});
