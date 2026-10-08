// Text models from every provider behind one call. Workers AI models, OpenAI and Anthropic (both billed
// through AI Gateway's unified billing) name their inputs and outputs differently; this builds the request
// and reads the answer for each. Pure: unit-tested in test/llm.test.ts.

export type Provider = "workers-ai" | "openai" | "anthropic";

export const providerOf = (model: string): Provider =>
	model.startsWith("anthropic/") ? "anthropic" : model.startsWith("openai/") ? "openai" : "workers-ai";

// A lead's decisions are a few hundred tokens of answer, so thinking hard costs little next to one frame.
// Claude thinks adaptively at high effort (a fixed budget_tokens is refused through the binding, 7003, on
// Opus and Sonnet 5.5: checked 2026-10-08); OpenAI's reasoning models take a high effort. Thinking shares
// the token budget with the answer, so it gets room on top.
const REASONING_ROOM = 8000;

/**
 * The input for env.AI.run. Anthropic rejects a "system" message: its system prompt is a top-level field.
 * `think` raises the thinking level where the provider has one (Workers AI's reasoning models think anyway).
 */
export function llmRequest(model: string, system: string, user: string, maxTokens: number, think = false) {
	switch (providerOf(model)) {
		case "anthropic":
			return think
				? { system, messages: [{ role: "user", content: user }], max_tokens: maxTokens + REASONING_ROOM, thinking: { type: "adaptive" }, output_config: { effort: "high" } }
				: { system, messages: [{ role: "user", content: user }], max_tokens: maxTokens };
		case "openai":
			// Reasoning models count their reasoning against this budget, like Kimi and Gemma
			return {
				messages: [{ role: "system", content: system }, { role: "user", content: user }],
				max_completion_tokens: think ? maxTokens + REASONING_ROOM : maxTokens,
				...(think ? { reasoning_effort: "high" } : {}),
			};
		default:
			return { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens };
	}
}

type Output = {
	response?: unknown;
	choices?: { message?: { content?: string | null } }[];
	content?: { type: string; text?: string }[];
	output_text?: string;
	usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
};

/** The answer's text, or "" when the model spent its budget without answering. */
export function llmText(out: unknown): string {
	const o = (out ?? {}) as Output;
	// Workers AI's own models answer in `response` (sometimes already-parsed JSON)
	if (typeof o.response === "string") return o.response;
	if (o.response !== undefined && o.response !== null) return JSON.stringify(o.response);
	// Anthropic: content blocks; thinking blocks carry no `text`
	if (Array.isArray(o.content)) return o.content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
	if (typeof o.output_text === "string") return o.output_text;
	// OpenAI-style: Kimi, Gemma 4, Nemotron, GPT
	return o.choices?.[0]?.message?.content ?? "";
}

/** Tokens used, for the record: providers name them differently. */
export function llmUsage(out: unknown) {
	const u = ((out ?? {}) as Output).usage ?? {};
	return { input: u.input_tokens ?? u.prompt_tokens ?? 0, output: u.output_tokens ?? u.completion_tokens ?? 0 };
}
