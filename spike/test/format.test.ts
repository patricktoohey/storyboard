// The season format (src/format-rules.ts): public moves and private reasons, twists, elimination, the
// finale's protect and steal, the backstory.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applySteal,
	backstoryOf,
	badFormat,
	claimsOf,
	eliminated,
	moneyForTime,
	moveLine,
	parseEntrantDraft,
	parseProtect,
	parseSteal,
	parseTwist,
	publicMove,
	rivalVersion,
	stealOrder,
	storyFor,
	swapSeat,
	twistOffers,
} from "../src/format-rules.ts";
import { type BoardSummary, parseDecision } from "../src/arena-rules.ts";
import type { Player, Seat } from "../src/cast-rules.ts";

const player = (name: string, seat: Seat, team?: string): Player => ({
	id: name.toLowerCase(),
	name,
	seat,
	team,
	bio: "",
	voice: "",
	model: "gemma-4",
	undersold: false,
	repo: `player-${name.toLowerCase()}`,
});

test("rivals see the move and its plain arguments, never the note or direction; a save's name is public", () => {
	assert.equal(publicMove("note", { cell: "02", note: "make her cry" }), "gave a note on cell 02");
	assert.equal(publicMove("replan", { direction: "noir" }), "planned the board again in a new direction (the old one saved)");
	assert.equal(publicMove("save", { name: "safe-fallback" }), 'saved the board as "safe-fallback"');
	const line = moveLine(new Date("2026-10-09T14:05:00Z"), 7, publicMove("save", { name: "safe-fallback" }), 'Playing it "safe"');
	assert.equal(line, `- 14:05 (turn 7) saved the board as "safe-fallback": "Playing it 'safe'"`);
});

test("a decision may carry a public message beside its private reason", () => {
	const s = { cells: [{ id: "01", takes: [] }] } as unknown as BoardSummary;
	const d = parseDecision('{"action": "save", "args": {"name": "abandoned noir"}, "reason": "this is our real plan", "message": "dead end, moving on"}', ["save"], s);
	assert.deepEqual(d, { action: "save", args: { name: "abandoned-noir" }, reason: "this is our real plan", message: "dead end, moving on" });
	// Without one, the decision is as before
	assert.deepEqual(parseDecision('{"action": "wait"}', ["wait"], s), { action: "wait", args: {}, reason: "" });
});

test("after a round, public messages are set beside private reasons by turn", () => {
	const moves = [moveLine(new Date(), 3, 'saved the board as "safe"', "our fallback"), moveLine(new Date(), 4, "re-shot cell 01")];
	const turns = [{ detail: 'turn 4: retake (opus) on cell 01 — try again' }, { detail: 'turn 3: save (opus): alt/safe at abc1234 [said publicly: "our fallback"] — this is the bold one, saved so we can come back' }];
	assert.deepEqual(claimsOf(moves, turns), [{ turn: 3, move: 'saved the board as "safe"', said: "our fallback", reason: "this is the bold one, saved so we can come back" }]);
});

test("a rival's version by team id or name; anything else isn't one", () => {
	const teams = [{ team: "opus", team_name: "Night Shift" }];
	assert.deepEqual(rivalVersion("rival:opus/main", teams), { team: "opus", version: "main" });
	assert.deepEqual(rivalVersion("rival:Night Shift/safe-v1", teams), { team: "opus", version: "safe-v1" });
	assert.equal(rivalVersion("rival:gpt/main", teams), undefined);
	assert.equal(rivalVersion("main", teams), undefined);
});

test("twists: everyone is offered the money, all but the last the swap; answers are checked", () => {
	assert.deepEqual(twistOffers(["a", "b", "c"]), { a: ["money_for_time", "swap"], b: ["money_for_time", "swap"], c: ["money_for_time"] });
	assert.deepEqual(parseTwist('{"money_for_time": true, "swap": "Sound designer", "say": "Deal."}', ["money_for_time", "swap"]), { money_for_time: true, swap: "sound", reason: "", say: "Deal." });
	// The last team can't swap, and nonsense refuses
	assert.deepEqual(parseTwist('{"swap": "writer"}', ["money_for_time"]), { money_for_time: false, reason: "", say: "" });
	assert.equal(parseTwist("no", ["money_for_time"]).money_for_time, false);
});

test("a swap moves the two players in one seat", () => {
	const players = [player("Ada", "writer", "a"), player("Bo", "writer", "b"), player("Cy", "sound", "a")];
	const { fromA, fromB } = swapSeat(players, "a", "b", "writer");
	assert.equal(fromA?.name, "Ada");
	assert.equal(fromB?.name, "Bo");
	assert.deepEqual(players.map((p) => p.team), ["b", "a", "a"]);
});

test("elimination takes the bottom of the standings, never everyone; steals go worst first, an entrant first of all", () => {
	assert.deepEqual(eliminated(["a", "b", "c", "d"], 2), ["c", "d"]);
	assert.deepEqual(eliminated(["a", "b"], 2), []);
	assert.deepEqual(eliminated(["a", "b"], 0), []);
	assert.deepEqual(stealOrder(["a", "b", "c"]), ["c", "b", "a"]);
	assert.deepEqual(stealOrder(["a", "b"], "wildcard"), ["wildcard", "b", "a"]);
});

test("protect one of your own; a steal names a rival's player or passes", () => {
	const mine = [player("Ada", "writer", "a"), player("Cy", "sound", "a")];
	assert.deepEqual(parseProtect('{"protect": "cy", "reason": "the score"}', mine), { player: "Cy", reason: "the score" });
	assert.equal(parseProtect('{"protect": "Bo"}', mine).player, "Ada");
	const theirs = [player("Bo", "writer", "b")];
	assert.deepEqual(parseSteal('{"steal": "bo", "say": "Mine now."}', theirs), { player: "Bo", reason: "", say: "Mine now." });
	assert.deepEqual(parseSteal('{"steal": null, "reason": "loyal"}', theirs), { reason: "loyal", say: "" });
	assert.ok("error" in parseSteal('{"steal": "Ada"}', theirs));
});

test("a steal on a protected player is blocked; otherwise the thief's own player in that seat is released", () => {
	const players = [player("Ada", "writer", "a"), player("Bo", "writer", "b"), player("Cy", "sound", "b")];
	assert.deepEqual(applySteal(players, "a", "Bo", ["Bo"]), { outcome: "blocked", from: "b" });
	assert.equal(players[1].team, "b");
	const r = applySteal(players, "a", "Bo", ["Cy"]);
	assert.equal(r.outcome, "stolen");
	assert.equal(players[1].team, "a");
	assert.equal(players[0].team, undefined);
	assert.equal(applySteal(players, "a", "Bo", []).outcome, "invalid");
});

test("an entrant signs one free agent per seat, falling back to the first free in a seat", () => {
	const free = [player("Ada", "writer"), player("Bo", "writer"), player("Cy", "cinematographer")];
	assert.deepEqual(parseEntrantDraft('{"writer": "Bo", "cinematographer": "Nobody"}', free).picks, { cinematographer: "Cy", writer: "Bo" });
});

test("the backstory: the previous season's champion, every team's line, a new team in the seat of one that left", () => {
	const prev = {
		title: "Season 1",
		teams: [{ team: "opus", lead: "claude-opus-5.5" }, { team: "gpt" }, { team: "llama" }],
		results: [
			{ round: 1, ranking: [{ team: "opus" }, { team: "gpt" }, { team: "llama" }] },
			{ round: 2, ranking: [{ team: "opus" }, { team: "llama" }, { team: "gpt" }] },
		],
	};
	const b = backstoryOf(prev, [{ team: "opus" }, { team: "gpt" }, { team: "nemotron" }], (l) => l ?? "?", "The champions are favourites.")!;
	assert.match(b.show, /^Season 1: 3 teams, 2 rounds\. opus \(led by claude-opus-5\.5\) won every round and the season with 6 points; then gpt \(led by \?\) 3, llama \(led by \?\) 3\. The champions are favourites\.$/);
	assert.match(b.teams.opus, /reigning champions of Season 1: 6 points, placed first then first/);
	assert.match(b.teams.gpt, /second of 3 in Season 1/);
	assert.match(b.teams.nemotron, /new this season, in the seat of llama/);
	assert.match(storyFor(b, "nemotron"), /^Your team is new.*Season 1: 3 teams/);
	assert.equal(backstoryOf(undefined, [], String), undefined);
	assert.deepEqual(backstoryOf(undefined, [], String, "Notes only."), { show: "Notes only.", teams: {} });
});

test("a format is checked before a season starts", () => {
	assert.match(badFormat({ twist_round: 2 }, false, 3)!, /cast/);
	assert.equal(badFormat({ twist_round: 2, eliminate: 1, entrant: { kind: "returning" } }, true, 3), undefined);
	assert.match(badFormat({ entrant: { kind: "returning" } }, true, 3)!, /elimination/);
	assert.match(badFormat({ twist_round: 5 }, true, 3)!, /twist_round/);
	assert.equal(badFormat({ eliminate: 2, entrant: { kind: "wildcard", lead: "claude-sonnet-5.5" } }, true, 3), undefined);
});

test("the money-for-time trade is sized to the round", () => {
	assert.deepEqual(moneyForTime(12, 60), { usd: 3, minutes: -10, text: "$3.00 more budget for 10 minutes less on the clock" });
	assert.deepEqual(moneyForTime(3, 20), { usd: 0.75, minutes: -3, text: "$0.75 more budget for 3 minutes less on the clock" });
});
