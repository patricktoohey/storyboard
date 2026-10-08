// The cast (src/cast-rules.ts): who undersells, the snake draft, picks, note replies, talk, and the reveal.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_POOL,
	MAX_UNDERSOLD,
	STRONG,
	UNDERSOLD_BONUS_USD,
	addressee,
	bonusFor,
	chooseUndersold,
	lastTalk,
	openSeats,
	parseNoteReply,
	parsePersona,
	parsePick,
	revealMd,
	snakeOrder,
	talkLine,
	uniqueId,
} from "../src/cast-rules.ts";
import { MENU } from "../src/crew.ts";
import { type BoardSummary, allowedActions, parseDecision } from "../src/arena-rules.ts";
import { llmRequest } from "../src/llm.ts";

test("the pool is on the menu, stars are scarce, every seat can be filled by four teams", () => {
	for (const p of DEFAULT_POOL) assert.ok(p.model in MENU.llm, p.model);
	assert.ok(DEFAULT_POOL.filter((p) => p.model === "claude-opus-5.5").length <= 2);
	for (const seat of ["cinematographer", "writer", "sound"]) assert.ok(DEFAULT_POOL.filter((p) => p.seat === seat).length >= 5, seat);
	// No slow models: players answer inside someone else's turn
	assert.ok(!DEFAULT_POOL.some((p) => p.model === "kimi-k2.6"));
});

test("only strong players undersell, and never more than two", () => {
	for (let i = 0; i < 20; i++) {
		const picked = chooseUndersold(DEFAULT_POOL, 5);
		assert.equal(picked.length, MAX_UNDERSOLD);
		for (const j of picked) assert.ok(STRONG.includes(DEFAULT_POOL[j].model), DEFAULT_POOL[j].model);
	}
	assert.deepEqual(chooseUndersold(DEFAULT_POOL, 0), []);
	assert.deepEqual(chooseUndersold([{ model: "gemma-4" }], 2), []);
});

test("a team that drafts an undersold player gets the producer's bonus", () => {
	assert.equal(bonusFor([{ undersold: false }, { undersold: true }]), UNDERSOLD_BONUS_USD);
	assert.equal(bonusFor([]), 0);
});

test("the draft snakes, and a roster still needs the seats it hasn't filled", () => {
	assert.deepEqual(snakeOrder(["a", "b", "c"]), ["a", "b", "c", "c", "b", "a", "a", "b", "c"]);
	assert.deepEqual(openSeats([{ seat: "writer" }]), ["cinematographer", "sound"]);
});

test("names become unique ids", () => {
	const taken = new Set<string>();
	assert.equal(uniqueId("Mara Quill", taken), "mara-quill");
	assert.equal(uniqueId("Mara  Quill!", taken), "mara-quill-2");
	assert.equal(uniqueId("Zoë", taken), "zoe");
});

test("a character needs a name, a bio and a voice; a lead also names its team", () => {
	const ok = parsePersona('Sure! {"name": "Ines Varga", "bio": "I cut trailers.", "voice": "low, dry"}');
	assert.ok(!("error" in ok) && ok.name === "Ines Varga");
	assert.ok("error" in parsePersona('{"name": "X", "bio": "y"}'));
	assert.ok("error" in parsePersona('{"name": "X", "bio": "y", "voice": "z"}', { teamName: true }));
	assert.ok("error" in parsePersona("no"));
});

test("a pick must be a free player in a seat the team still needs", () => {
	const available = [
		{ name: "Ines Varga", seat: "writer" as const },
		{ name: "Theo Park", seat: "sound" as const },
	];
	assert.deepEqual(parsePick('{"player": "ines varga", "reason": "words", "say": "Hello"}', available, ["writer"]), { player: "Ines Varga", reason: "words", say: "Hello" });
	assert.ok("error" in parsePick('{"player": "Theo Park"}', available, ["writer"]));
	assert.ok("error" in parsePick('{"player": "Nobody"}', available, ["writer", "sound"]));
});

test("a note reply agrees unless it says push_back; an alternative only comes with a push back", () => {
	assert.deepEqual(parseNoteReply('{"stance": "agree", "reply": "On it.", "alternative": "ignored"}'), { stance: "agree", reply: "On it." });
	assert.deepEqual(parseNoteReply('{"stance": "push_back", "reply": "That flattens her.", "alternative": "Keep the shadow"}'), {
		stance: "push_back",
		reply: "That flattens her.",
		alternative: "Keep the shadow",
	});
	assert.ok("error" in parseNoteReply('{"stance": "agree"}'));
});

test("talk is one markdown line per utterance, and transcripts are read back by line", () => {
	const at = new Date("2026-10-08T14:05:00Z");
	assert.equal(talkLine(at, "Ada", "Shoot it  wider.\n", "Ren"), "- 14:05 **Ada** → **Ren**: Shoot it wider.");
	assert.equal(talkLine(at, "Ada", "Hi"), "- 14:05 **Ada**: Hi");
	assert.deepEqual(lastTalk("# Crew\n\n- a\n## Round 2\n- b\n- c\n", 2), ["- b", "- c"]);
	assert.deepEqual(lastTalk(null, 3), []);
	assert.equal(addressee("Everyone", ["Ren Ito"]), "crew");
	assert.equal(addressee("ren", ["Ren Ito"]), "Ren Ito");
	assert.equal(addressee("Bob", ["Ren Ito"]), undefined);
});

test("the reveal names every player's real model and who undersold", () => {
	const md = revealMd(
		{
			players: [{ id: "r", name: "Ren", seat: "cinematographer", bio: "", voice: "", model: "claude-opus-5.5", undersold: true, repo: "p", team: "opus" }],
			leads: [],
			judges: [],
		},
		{ opus: "Night Shift" },
	);
	assert.match(md, /\| Ren \| cinematographer \| Night Shift \| Claude Opus 5\.5 \| yes \|/);
});

const summary = (over: Partial<BoardSummary> = {}): BoardSummary => ({
	drafted: true,
	planned: true,
	planRequested: true,
	cells: [{ id: "01", printed: 1, takes: [{ take: 1, done: true, ok: true, stale: false, issues: [] }] }],
	cutRunning: false,
	submitted: false,
	openJobs: 0,
	spent: 1,
	budget: 12,
	now: 0,
	deadline: 60 * 60 * 1000,
	cutSeconds: 6,
	prices: { take: 0.05, turn: 0.05, cut: 0.6, board: 0.2 },
	...over,
});

test("a cast team can talk to its crew, and post to the commons unless the round is blind", () => {
	assert.ok(!allowedActions(summary()).includes("talk"));
	const open = allowedActions(summary({ talk: { names: ["Ren Ito"], commons: true } }));
	assert.ok(open.includes("talk") && open.includes("post"));
	const blind = allowedActions(summary({ talk: { names: ["Ren Ito"], commons: false } }));
	assert.ok(blind.includes("talk") && !blind.includes("post"));
	const s = summary({ talk: { names: ["Ren Ito"], commons: true } });
	assert.deepEqual(parseDecision('{"action": "talk", "args": {"to": "Ren", "message": "Wider?"}, "reason": "r"}', open, s), {
		action: "talk",
		args: { to: "Ren Ito", message: "Wider?" },
		reason: "r",
	});
	assert.ok("error" in parseDecision('{"action": "talk", "args": {"to": "Bob", "message": "Hi"}}', open, s));
	assert.ok("error" in parseDecision('{"action": "post", "args": {}}', open, s));
});

test("leads think hard: Claude adaptively at high effort, OpenAI at high reasoning effort, with room on top", () => {
	const claude = llmRequest("anthropic/claude-opus-5.5", "s", "u", 4096, true) as Record<string, unknown>;
	assert.deepEqual(claude.thinking, { type: "adaptive" });
	assert.deepEqual(claude.output_config, { effort: "high" });
	assert.ok((claude.max_tokens as number) > 4096);
	const gpt = llmRequest("openai/gpt-6.1-sol", "s", "u", 4096, true) as Record<string, unknown>;
	assert.equal(gpt.reasoning_effort, "high");
	assert.ok((gpt.max_completion_tokens as number) > 4096);
	// Without think, nothing changes; Workers AI models ignore it
	assert.equal((llmRequest("anthropic/claude-opus-5.5", "s", "u", 4096) as Record<string, unknown>).thinking, undefined);
	assert.equal((llmRequest("@cf/moonshotai/kimi-k2.6", "s", "u", 4096, true) as Record<string, unknown>).reasoning_effort, undefined);
});
