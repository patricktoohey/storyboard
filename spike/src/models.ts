// The four model roles from docs/design.md: director, cinematographer, renderer, critic.

export const SHOT_SIZES = {
	EWS: "Extreme wide shot: location dominates, figures tiny",
	WS: "Wide shot: full body with surroundings",
	MS: "Medium shot: waist up",
	CU: "Close-up: face or a single object fills the frame",
	ECU: "Extreme close-up: a detail such as eyes, hands, text",
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;

export interface Cell {
	id: string;
	beat: string;
	shot: ShotSize;
	camera: string;
	duration_s: number;
}

export interface Board {
	title: string;
	bible: string;
	cells: Cell[];
}

async function chat(env: Env, model: string, system: string, user: string) {
	const out = (await env.AI.run(model as keyof AiModels, {
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		max_tokens: 2048,
	} as never)) as { response?: unknown };
	// Some models return already-parsed JSON in `response`
	return typeof out.response === "string" ? out.response : JSON.stringify(out.response);
}

function extractJson<T>(text: string): T {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function direct(env: Env, concept: string, cellCount: number): Promise<Board> {
	const system = `You are a film director planning a storyboard. Reply with ONLY a JSON object:
{"title": string,
 "bible": string  // markdown style bible: ## Look (format, palette, light, lenses), ## Characters (name: age, face, hair, wardrobe), ## Locations
 "cells": [{"beat": string, "shot": one of ${Object.keys(SHOT_SIZES).join("|")}, "camera": string, "duration_s": number}]}
Write exactly ${cellCount} cells. A beat is one plain sentence of what happens. Vary shot sizes.`;
	const board = extractJson<Omit<Board, "cells"> & { cells: Omit<Cell, "id">[] }>(
		await chat(env, env.DIRECTOR_MODEL, system, concept),
	);
	return {
		title: board.title,
		bible: board.bible,
		cells: board.cells.slice(0, cellCount).map((c, i) => ({
			...c,
			id: String(i + 1).padStart(2, "0"),
			shot: c.shot in SHOT_SIZES ? c.shot : "MS",
		})),
	};
}

export async function cinematograph(env: Env, bible: string, cell: Cell) {
	const system = `You are a cinematographer writing a text-to-image prompt for one storyboard frame.
Use the style bible so every frame shares the same look and characters (repeat character wardrobe and features verbatim).
Lead with the framing (${cell.shot}: ${SHOT_SIZES[cell.shot]}), then lens, angle, subject and action, setting, light, palette, texture.
Reply with ONLY the prompt, one paragraph, under 120 words.

STYLE BIBLE:
${bible}`;
	const prompt = (await chat(env, env.CINEMATOGRAPHER_MODEL, system, `Beat: ${cell.beat}\nCamera: ${cell.camera}`)).trim();
	return prompt.replace(/^"|"$/g, "");
}

async function toWebp(env: Env, jpeg: Uint8Array, width?: number) {
	let img = env.IMAGES.input(new Blob([jpeg]).stream());
	if (width) img = img.transform({ width });
	const result = await img.output({ format: "image/webp", quality: 80 });
	return new Uint8Array(await new Response(result.image()).arrayBuffer());
}

function toBase64(bytes: Uint8Array) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

// flux-1-schnell accepts only prompt + steps (no seed), so takes aren't reproducible yet
export async function render(env: Env, prompt: string) {
	const started = Date.now();
	const out = (await env.AI.run(env.RENDER_MODEL as keyof AiModels, { prompt, steps: 4 } as never)) as unknown as {
		image: string;
	};
	const jpeg = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
	const [frame, preview] = await Promise.all([toWebp(env, jpeg), toWebp(env, jpeg, 384)]);
	return {
		frame,
		previewBase64: toBase64(preview),
		meta: {
			model: env.RENDER_MODEL,
			steps: 4,
			bytes: { source_jpeg: jpeg.byteLength, frame_webp: frame.byteLength, preview_webp: preview.byteLength },
			elapsed_ms: Date.now() - started,
		},
	};
}

/** Clef: typed questions about the frame, answered with probabilities instead of prose. */
export async function review(env: Env, cell: Cell, prompt: string, webpBase64: string) {
	const started = Date.now();
	const out = (await env.AI.run(`@cf/cloudflare/${env.CLEF_MODEL}` as keyof AiModels, {
		model: env.CLEF_MODEL,
		state: { prompt, intended_shot: cell.shot },
		images: [{ content_type: "image/webp", base64: webpBase64 }],
		questions: {
			adherence: {
				type: "score",
				instructions: "How well does the image depict `prompt`?",
				criteria: ["Unrelated", "Weak", "Partial", "Good", "Exact"],
			},
			framing: {
				type: "choice",
				instructions: "Which shot size is the image?",
				criteria: SHOT_SIZES,
			},
			artifacts: {
				type: "noul",
				instructions: "Does the image have obvious generation defects (garbled text, extra limbs, warped faces)?",
			},
		},
	} as never)) as unknown as { answers: Record<string, unknown> };
	return { model: env.CLEF_MODEL, elapsed_ms: Date.now() - started, ...out.answers };
}
