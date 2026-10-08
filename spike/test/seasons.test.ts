// Comparative judging and seasons (docs/arena.md): matchups both ways, win rates, standings, and the
// retrospective's guardrail on rewriting a skill.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type Comparison, matchups, replaceStrategy, seasonStandings, strategyOf, winRates } from "../src/arena-rules.ts";

test("every pair is judged in both orders", () => {
	assert.deepEqual(matchups(["a", "b", "c"]), [["a", "b"], ["a", "c"], ["b", "a"], ["b", "c"], ["c", "a"], ["c", "b"]]);
});

test("asking both ways cancels a judge's preference for the first position", () => {
	// A judge that always prefers whichever board comes first (p=0.7) rates two equal teams 0.5 each
	const biased: Comparison[] = [
		{ judge: "j", first: "a", second: "b", pFirst: { arc: 0.7 } },
		{ judge: "j", first: "b", second: "a", pFirst: { arc: 0.7 } },
	];
	const r = winRates(biased, {});
	assert.equal(r.overall.a, 0.5);
	assert.equal(r.overall.b, 0.5);
});

test("win rates follow the comparisons, per judge, per criterion and weighted overall", () => {
	const cs: Comparison[] = [
		{ judge: "craft", first: "a", second: "b", pFirst: { continuity: 0.9, framing: 0.7 } },
		{ judge: "craft", first: "b", second: "a", pFirst: { continuity: 0.2, framing: 0.4 } },
		{ judge: "story", first: "a", second: "b", pFirst: { arc: 0.3 } },
		{ judge: "story", first: "b", second: "a", pFirst: { arc: 0.6 } },
	];
	const r = winRates(cs, { craft: 1, story: 3 });
	assert.equal(r.byJudge.a.craft, 0.75); // (0.9 + 0.7 + 0.8 + 0.6) / 4
	assert.equal(r.byJudge.a.story, 0.35); // (0.3 + 0.4) / 2
	assert.equal(r.byCriterion.b.arc, 0.65);
	assert.equal(r.overall.a, Number(((0.75 + 3 * 0.35) / 4).toFixed(3)));
	assert.ok(Math.abs(r.overall.a + r.overall.b - 1) < 1e-9, "two teams' win rates sum to 1");
});

test("season standings: 3/2/1 points per round, nothing for a team without video", () => {
	const s = seasonStandings([
		{ round: 1, ranking: [{ team: "safe", winRate: 0.6 }, { team: "docs", winRate: 0.5 }, { team: "auteur", winRate: 0.4, disqualified: "no video" }] },
		{ round: 2, ranking: [{ team: "auteur", winRate: 0.7 }, { team: "safe", winRate: 0.5 }, { team: "docs", winRate: 0.3 }] },
	]);
	assert.deepEqual(s.map((x) => [x.team, x.points]), [["safe", 5], ["auteur", 3], ["docs", 3]]);
	assert.deepEqual(s.find((x) => x.team === "auteur")?.winRates, [0.4, 0.7]);
});

const AUTEUR = readFileSync(new URL("../../skills/showrunner-auteur/SKILL.md", import.meta.url), "utf8");

test("a retrospective rewrites only the Strategy section", () => {
	const next = replaceStrategy(AUTEUR, "## Strategy\n\n- Stop after two failed notes on a cell; print what passes.");
	assert.match(next, /## Strategy\n\n- Stop after two failed notes on a cell; print what passes.\n/);
	assert.ok(!next.includes("Quality first."), "the old strategy is gone");
	assert.ok(next.includes("## Notes"), "the notes section is untouched");
	assert.ok(next.startsWith("---\nname: showrunner-auteur"), "frontmatter is untouched");
});

test("an empty or oversized rewrite leaves the skill unchanged", () => {
	assert.equal(replaceStrategy(AUTEUR, "   "), AUTEUR);
	assert.equal(replaceStrategy(AUTEUR, "x".repeat(5000)), AUTEUR);
	assert.equal(replaceStrategy("# no strategy here", "- something"), "# no strategy here");
});

test("strategyOf reads just the Strategy section", () => {
	const s = strategyOf(AUTEUR);
	assert.match(s, /^- Quality first\./);
	assert.ok(!s.includes("## Notes"));
	assert.equal(strategyOf(replaceStrategy(AUTEUR, "- Print early.")), "- Print early.");
});
