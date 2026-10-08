// The crew draft (docs/arena.md): Cloudflare prices per slot, what jobs cost with a crew, fitting a drafted
// crew to a budget, and the per-provider video requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CREW, MENU, SLOTS, type Crew, cheapestFilm, clipCost, crewCosts, crewFrom, draftOptions, fitToBudget, isCrew, videoRequest } from "../src/crew.ts";
import { estimate } from "../src/costs.ts";

const budget: Crew = { llm: "gemma-4", lead: "gemma-4", renderer: "flux-2-klein-4b", critic: "clef-flash", video: "hailuo-2.3-fast" };
const premium: Crew = { llm: "kimi-k2.6", lead: "kimi-k2.6", renderer: "flux-2-dev", critic: "clef", video: "veo-3.1-fast" };
const clips = [5, 5, 5, 5];

test("today's pipeline costs about $0.024 a take, a little under the old flat $0.03", () => {
	const c = crewCosts(DEFAULT_CREW);
	assert.ok(c.take > 0.02 && c.take < 0.03, `take ${c.take}`);
	assert.equal(estimate({ kind: "take", cell: "01" }), c.take);
});

test("a budget crew shoots a take for under a cent; a premium crew for about 6 cents", () => {
	assert.ok(crewCosts(budget).take < 0.01);
	assert.ok(crewCosts(premium).take > 0.05 && crewCosts(premium).take < 0.07);
});

test("clips are billed at the provider's lengths, not the plan's", () => {
	assert.deepEqual(clipCost({ ...DEFAULT_CREW, video: "hailuo-2.3-fast" }, 3), { billed: 6, usd: 0.19 });
	assert.deepEqual(clipCost({ ...DEFAULT_CREW, video: "veo-3.1-fast" }, 5), { billed: 6, usd: 0.48 });
	assert.equal(clipCost({ ...DEFAULT_CREW, video: "seedance-2.0-fast" }, 2).billed, 4);
	assert.equal(clipCost(DEFAULT_CREW, 3).billed, 3);
	assert.equal(estimate({ kind: "video", cell: "01", cut: "v1", origin: "o", seconds: 3 }, { ...DEFAULT_CREW, video: "hailuo-2.3-fast" }), 0.19);
});

test("a 4-cell film: ~$0.85 with the budget crew, ~$2.30 with the premium one", () => {
	assert.ok(Math.abs(cheapestFilm(budget, clips) - 0.85) < 0.1, String(cheapestFilm(budget, clips)));
	assert.ok(Math.abs(cheapestFilm(premium, clips) - 2.3) < 0.2, String(cheapestFilm(premium, clips)));
});

test("the draft only offers video models that work on photoreal people: LTX, Seedance and Veo are out", () => {
	// Checked live: LTX's provider is out of funds; Seedance and Veo refuse frames that show realistic people
	assert.deepEqual(draftOptions("video").sort(), ["hailuo-2.3-fast", "wan-2.7-i2v"]);
	assert.equal(draftOptions("renderer").length, 3);
});

test("an affordable draft is kept as is", () => {
	const fit = fitToBudget(premium, clips, 5);
	assert.deepEqual(fit.crew, premium);
	assert.deepEqual(fit.changes, []);
});

test("an unaffordable draft is downgraded, biggest saving first, until its cheapest film fits", () => {
	const fit = fitToBudget(premium, clips, 2);
	assert.ok(fit.film <= 2 * 0.8, `film ${fit.film}`);
	assert.match(fit.changes[0], /^video: veo-3.1-fast → /);
	assert.ok(isCrew(fit.crew));
});

test("every option in the menu has a price and an id", () => {
	for (const slot of SLOTS) for (const [key, option] of Object.entries(MENU[slot])) assert.ok(option.id && option.label, `${slot}/${key}`);
	assert.equal(isCrew({ ...DEFAULT_CREW, video: "sora" }), false);
});

test("each video model gets its own request shape", () => {
	const req = (video: Crew["video"], seconds = 5, staticCamera = false) =>
		videoRequest({ ...DEFAULT_CREW, video }, { url: "https://img", base64: "QUJD" }, "move", seconds, { seed: 7, staticCamera });
	assert.deepEqual(req("wan-2.7-i2v").input, { prompt: "move", image: "https://img", duration: 5, resolution: "720P", seed: 7, watermark: false });
	assert.equal(req("veo-3.1-fast", 3).input.duration, "4s");
	// Veo takes raw base64: a URL fails and a data: URL is "Invalid base64"
	assert.equal(req("veo-3.1-fast").input.image_input, "QUJD");
	assert.equal(req("ltx-2.5-fast").input.image_uri, "https://img");
	assert.equal(req("hailuo-2.3-fast").input.first_frame_image, "https://img");
	assert.equal(req("hailuo-2.3-fast", 3).input.duration, 6);
	const seedance = req("seedance-2.0-fast", 5, true);
	assert.equal(seedance.model, "bytedance/seedance-2.0-fast");
	assert.equal(seedance.input.aspect_ratio, "21:9");
	assert.equal(seedance.input.camera_fixed, true);
});

test("the lead slot: frontier models on the menu, old crews lead with their one LLM, a pinned lead is never downgraded", () => {
	for (const m of ["claude-opus-5.5", "claude-sonnet-5.5", "gpt-6.1-sol", "gpt-5.4-mini"]) assert.ok(m in MENU.lead && m in MENU.llm, m);
	// Crews drafted before the lead slot existed
	assert.deepEqual(crewFrom({ llm: "kimi-k2.6", renderer: "flux-2-dev", critic: "clef", video: "wan-2.7-i2v" })?.lead, "kimi-k2.6");
	assert.equal(crewFrom({ llm: "nope" }), undefined);
	const opus: Crew = { ...premium, lead: "claude-opus-5.5", video: "wan-2.7-i2v" };
	const fit = fitToBudget(opus, clips, 1.5, 0.8, ["lead"]);
	assert.equal(fit.crew.lead, "claude-opus-5.5");
	assert.ok(!fit.changes.some((c) => c.startsWith("lead")));
});

test("frontier leads cost cents per plan, not dollars: the video is still the bill", () => {
	const opus = crewCosts({ ...DEFAULT_CREW, lead: "claude-opus-5.5" });
	const llama = crewCosts(DEFAULT_CREW);
	// A plan with Opus (thinking included) costs a few cents more than with Llama; a 5 s Wan clip is $0.50
	assert.ok(opus.board - llama.board < 0.06, `plan ${opus.board} vs ${llama.board}`);
	assert.ok(opus.turn < 0.05, `turn ${opus.turn}`);
	// The cinematographer is the llm slot: a frontier lead doesn't change what a take costs
	assert.equal(opus.take, llama.take);
});
