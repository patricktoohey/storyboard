// D39: out of AI Gateway credits. Season 2's round 2 panel counted every judge as even and its finale's leads
// spent all 60 turns re-planning into a gateway that answered 2021 to everything.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PAUSED, creditsFailure, turnsUsed } from "../src/arena-rules.ts";
import { seasonEstimate, tooLittle } from "../src/credits.ts";
import { outOfCredits } from "../src/llm.ts";
import { FILM_SECONDS, withRecap } from "../src/sound-rules.ts";

const at = (m: number) => `2026-10-09T22:${String(m).padStart(2, "0")}:00Z`;

test("D39: the gateway's out-of-credits error is told apart from a rate limit", () => {
	assert.ok(outOfCredits("AiGatewayError: 2021: Insufficient AI Gateway credits"));
	assert.ok(outOfCredits(new Error("[2021] Insufficient balance; add money to your gateway or use BYOK")));
	assert.ok(!outOfCredits("3021: rate limited"));
	assert.ok(!outOfCredits("cell 12021 failed"));
});

test("D39: a team pauses once per out-of-credits failure, then tries again", () => {
	// Newest first, as the ledger is
	const failed = { kind: "board", status: "failed", detail: "AiGatewayError: 2021: Insufficient AI Gateway credits", updated: at(5) };
	assert.equal(creditsFailure([failed, { kind: "turn", status: "done", result: "acted", detail: "turn 2: plan (required)", updated: at(4) }]), "board failed");
	// Paused since: the next turn tries again rather than pausing forever
	const paused = { kind: "turn", status: "done", result: "waited", detail: `${PAUSED}: the AI Gateway is out of credits`, updated: at(6) };
	assert.equal(creditsFailure([paused, failed]), undefined);
	// The retry failed the same way: pause again
	assert.equal(creditsFailure([{ ...failed, updated: at(9) }, paused, failed]), "board failed");
	// Other failures aren't a reason to pause
	assert.equal(creditsFailure([{ ...failed, detail: "3040: out of capacity" }]), undefined);
});

test("D39: a plan that failed gives its turn back", () => {
	const plan = (status: string) => [
		{ kind: "board", status, updated: at(1) },
		{ kind: "turn", status: "done", result: "acted", detail: "turn 1: plan (required)", updated: at(1) },
	];
	assert.equal(turnsUsed([...plan("failed"), ...plan("failed"), ...plan("done")]), 1);
	assert.equal(turnsUsed([{ kind: "turn", status: "done", result: "waited", updated: at(1) }]), 0);
});

test("D39: a film planned past the brief is fitted to 30 seconds, recap or not", () => {
	const film = Array.from({ length: 8 }, (_, i) => ({ cell: `0${i + 1}`, file: `video/0${i + 1}.mp4`, seconds: 5, audio: false }));
	const fitted = withRecap(film, null, FILM_SECONDS);
	assert.equal(Number(fitted.reduce((s, c) => s + c.seconds, 0).toFixed(2)), 30);
	assert.equal(fitted[0].seconds, 3.75);
	const recapped = withRecap(film, { shots: [{ branch: "cell/01/take-1", file: "recap/01.webp" }, { branch: "cell/02/take-1", file: "recap/02.webp" }] }, FILM_SECONDS);
	assert.equal(Number(recapped.reduce((s, c) => s + c.seconds, 0).toFixed(2)), 30);
	assert.deepEqual(recapped.slice(0, 2).map((c) => c.seconds), [2, 2]);
	// Short enough already: untouched
	const short = film.slice(0, 6);
	assert.equal(withRecap(short, null, FILM_SECONDS), short);
});

test("D39: a season doesn't start on less than it can cost", () => {
	// Season 2: 3 rounds, 3 teams, $16 each
	assert.equal(seasonEstimate(3, 3, 16), 114);
	assert.match(tooLittle(50, 114) ?? "", /\$50\.00 in credits.*about \$114\.00/);
	assert.equal(tooLittle(120, 114), undefined);
	// No token to read the balance with: no check
	assert.equal(tooLittle(undefined, 114), undefined);
});
