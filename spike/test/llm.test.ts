// Text models from three providers behind one call (src/llm.ts): request shapes and answer parsing,
// recorded from live calls through the Worker's AI binding on 2026-10-08.
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmRequest, llmText, llmUsage, providerOf, retryDelay } from "../src/llm.ts";

test("Anthropic gets its system prompt as a top-level field; it rejects a system message", () => {
	assert.equal(providerOf("anthropic/claude-opus-5.5"), "anthropic");
	const req = llmRequest("anthropic/claude-opus-5.5", "You direct.", "Plan it.", 4096) as Record<string, unknown>;
	assert.equal(req.system, "You direct.");
	assert.deepEqual(req.messages, [{ role: "user", content: "Plan it." }]);
	assert.equal(req.max_tokens, 4096);
});

test("OpenAI, Gemini and Workers AI take a system message; OpenAI and Gemini budget completion tokens", () => {
	const gpt = llmRequest("openai/gpt-6.1-sol", "s", "u", 100) as Record<string, unknown>;
	assert.equal((gpt.messages as { role: string }[])[0].role, "system");
	assert.equal(gpt.max_completion_tokens, 100);
	// Gemini takes OpenAI's shape through the binding, thinking included
	assert.equal(providerOf("google/gemini-3.1-pro"), "google");
	assert.deepEqual(llmRequest("google/gemini-3.1-pro", "s", "u", 100, true), {
		messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
		max_completion_tokens: 8100,
		reasoning_effort: "high",
	});
	const llama = llmRequest("@cf/meta/llama-3.3-70b-instruct-fp8-fast", "s", "u", 100) as Record<string, unknown>;
	assert.equal(llama.max_tokens, 100);
});

test("answers are read from each provider's shape, and thinking isn't the answer", () => {
	assert.equal(llmText({ response: "hi" }), "hi");
	assert.equal(llmText({ response: { a: 1 } }), '{"a":1}');
	assert.equal(llmText({ content: [{ type: "thinking" }, { type: "text", text: "A storyboard" }, { type: "text", text: " is..." }] }), "A storyboard is...");
	assert.equal(llmText({ choices: [{ message: { content: "Plan" } }] }), "Plan");
	// Kimi out of budget: content null after reasoning
	assert.equal(llmText({ choices: [{ message: { content: null } }] }), "");
	assert.deepEqual(llmUsage({ usage: { input_tokens: 27, output_tokens: 56 } }), { input: 27, output: 56 });
	assert.deepEqual(llmUsage({ usage: { prompt_tokens: 21, completion_tokens: 30 } }), { input: 21, output: 30 });
	assert.deepEqual(llmUsage({}), { input: 0, output: 0 });
});

test("D37: a rate limit waits out the minute; other transient errors retry quickly", () => {
	assert.equal(retryDelay(new Error("AiError: 3021: rate limiting: inference request per min rate reached"), 1), 20_000);
	assert.equal(retryDelay(new Error("AiError: 3021: rate limiting"), 3), 60_000);
	assert.equal(retryDelay(new Error("AiError: 3043: Internal server error"), 2), 2_000);
});
