// The model roles from docs/design.md: director, casting, cinematographer, renderer, critic, continuity.
// Director, cinematographer and casting take their craft from a skill in the board repo (skills.ts);
// what stays here is each role's output contract, which code depends on.
import { continuityQuestions, continuityVerdict } from "./continuity-rules.ts";
import { insertLooks } from "./looks";
import { type NoteAction, routerRequest } from "./router.ts";
import { type Skill, promptTemplate } from "./skills";
import {
	type Board,
	type Cell,
	type Character,
	type ClefAnswer,
	type Reference,
	AGE_BANDS,
	AGE_WORDS,
	SHOT_ORDER,
	SHOT_SIZES,
	slug,
	usesPortraits,
} from "./vocab.ts";

export * from "./vocab.ts";
export { NOTE_ACTIONS, type NoteAction } from "./router.ts";

// Workers AI errors worth retrying: 3040 out of capacity, 3043 internal error, 3030 output flagged by the
// safety filter (often a false positive; only worth retrying with a new seed, so image calls pass it)
const TRANSIENT = ["3040", "3043"];

async function withRetry<T>(fn: (attempt: number) => Promise<T>, retryOn = TRANSIENT, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			if (attempt >= attempts || !retryOn.some((code) => String(err).includes(code))) throw err;
			await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
		}
	}
}

async function chat(env: Env, model: string, system: string, user: string) {
	const messages = [
		{ role: "system", content: system },
		{ role: "user", content: user },
	];
	const out = (await withRetry(() =>
		env.AI.run(model as keyof AiModels, { messages, max_tokens: 2048 } as never),
	)) as { response?: unknown };
	// Some models return already-parsed JSON in `response`
	return typeof out.response === "string" ? out.response : JSON.stringify(out.response);
}

function extractJson<T>(text: string): T {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`no JSON object in model output: ${text.slice(0, 200)}`);
	return JSON.parse(text.slice(start, end + 1)) as T;
}

export async function direct(env: Env, skill: Skill, concept: string, cellCount: number): Promise<Board> {
	const system = `${skill.body}

## Output contract
Reply with ONLY a JSON object:
{"title": string,
 "bible": string,  // markdown style bible with two sections: ## Look (format, palette, light, lenses) and ## Locations
 "characters": [{"name": string, "age_band": one of ${Object.keys(AGE_BANDS).join("|")},
                 "look": string}],  // under 30 words of visual facts only, starting with exact age and sex ("58-year-old woman, ..."), then face, hair, build, wardrobe
 "cells": [{"beat": string, "shot": one of ${SHOT_ORDER.join("|")}, "camera": string, "duration_s": number,
            "characters": [names of characters visible in the frame]}]}
Write exactly ${cellCount} cells.`;
	const board = extractJson<Omit<Board, "cells"> & { cells: Omit<Cell, "id">[] }>(
		await chat(env, skill.metadata.model ?? env.DIRECTOR_MODEL, system, concept),
	);
	const characters = (board.characters ?? []).map((c) => {
		const age_band = c.age_band in AGE_BANDS ? c.age_band : "young_adult";
		// Age must be in the look itself; "worn face" alone renders as 30
		const statesAge = /\d|child|teen|young|middle|elderly|old/i.test(c.look);
		return { ...c, age_band, look: statesAge ? c.look : `${AGE_WORDS[age_band]} ${c.look}` };
	});
	const known = new Set(characters.map((c) => c.name));
	return {
		title: board.title,
		bible: board.bible,
		characters,
		cells: board.cells.slice(0, cellCount).map((c, i) => ({
			...c,
			id: String(i + 1).padStart(2, "0"),
			shot: c.shot in SHOT_SIZES ? c.shot : "MS",
			characters: (c.characters ?? []).filter((n) => known.has(n)),
		})),
	};
}

export async function cinematograph(
	env: Env,
	skill: Skill,
	bible: string,
	cast: Character[],
	cell: Cell,
	direction?: string,
) {
	const castLines = cast.map((c) => `- {{${c.name}}}`).join("\n");
	const system = `${skill.body}

## Output contract
This frame is a ${cell.shot}: ${SHOT_SIZES[cell.shot]}.
${
	cast.length
		? `Characters in this frame. Refer to each ONLY by its placeholder, exactly as written, never possessive; it is replaced with the full description:
${castLines}`
		: "No characters are visible in this frame; do not add people."
}
Reply with ONLY the prompt text.

## Style bible
${bible}`;
	const brief = [`Beat: ${cell.beat}`, `Camera: ${cell.camera}`];
	if (direction) brief.push(direction);
	const draft = (await chat(env, skill.metadata.model ?? env.CINEMATOGRAPHER_MODEL, system, brief.join("\n")))
		.trim()
		.replace(/^"|"$/g, "");
	return insertLooks(draft, cast);
}

async function encode(env: Env, image: Uint8Array, format: "image/webp" | "image/jpeg", width?: number) {
	let img = env.IMAGES.input(new Blob([image]).stream());
	if (width) img = img.transform({ width, height: width, fit: "scale-down" });
	const result = await img.output({ format, quality: 85 });
	return new Uint8Array(await new Response(result.image()).arrayBuffer());
}

function toBase64(bytes: Uint8Array) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

interface RenderOptions {
	width: number;
	height: number;
	references?: Reference[];
}

/** Each attempt gets a fresh seed, so a flagged output (3030) can come out clean on retry. */
async function runImageModel(env: Env, prompt: string, opts: RenderOptions) {
	return withRetry(async (attempt) => {
		const seed = randomSeed();
		return { bytes: await runImageModelOnce(env, prompt, { ...opts, seed }), seed, attempts: attempt };
	}, [...TRANSIENT, "3030"]);
}

/** flux-2 models take multipart form data (and reference images); flux-1-schnell takes JSON with no seed. */
async function runImageModelOnce(env: Env, prompt: string, opts: RenderOptions & { seed: number }) {
	let out: { image: string };
	if (env.RENDER_MODEL.includes("flux-2")) {
		const form = new FormData();
		form.append("prompt", prompt);
		form.append("width", String(opts.width));
		form.append("height", String(opts.height));
		form.append("seed", String(opts.seed));
		opts.references?.forEach((r, i) => form.append(`input_image_${i}`, new Blob([r.jpeg], { type: "image/jpeg" })));
		const body = new Response(form);
		out = (await env.AI.run(env.RENDER_MODEL as keyof AiModels, {
			multipart: { body: body.body, contentType: body.headers.get("content-type") },
		} as never)) as unknown as { image: string };
	} else {
		out = (await env.AI.run(env.RENDER_MODEL as keyof AiModels, { prompt, steps: 4 } as never)) as unknown as {
			image: string;
		};
	}
	return Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

/** Casting agent: one neutral portrait per character, rendered before any cell. */
export async function cast(env: Env, skill: Skill, character: Character): Promise<Reference & { webp: Uint8Array }> {
	const prompt = promptTemplate(skill).replace("{{look}}", character.look);
	const { bytes: source } = await runImageModel(env, prompt, { width: 768, height: 768 });
	const [webp, reference] = await Promise.all([encode(env, source, "image/webp"), portraitReference(env, character, source)]);
	return { ...reference, webp };
}

export const portraitPath = (character: Character) => `bible/refs/${slug(character.name)}.webp`;

/** Turns a portrait (fresh from casting, or read back from the repo) into render and Clef inputs. */
export async function portraitReference(env: Env, character: Character, image: Uint8Array): Promise<Reference> {
	const [jpeg, preview] = await Promise.all([encode(env, image, "image/jpeg", 496), encode(env, image, "image/webp", 384)]);
	return { character, path: portraitPath(character), jpeg, previewBase64: toBase64(preview) };
}

export async function render(env: Env, cell: Cell, prompt: string, references: Reference[]) {
	const started = Date.now();
	const refs = usesPortraits(cell.shot) ? references.slice(0, 4) : [];
	// Image models don't know "EWS"; spell the framing out first
	const framed = `${SHOT_SIZES[cell.shot]}. ${prompt}`;
	// Tie each reference image to the description it anchors
	const anchored = refs.length
		? `${framed} ${refs.map((r, i) => `The ${r.character.look.split(",")[0]} is the person in image ${i}: keep the same face, hair and wardrobe.`).join(" ")}`
		: framed;
	// 1344x576 is close to 2.39:1 anamorphic and divisible by 16
	const { bytes: source, seed, attempts } = await runImageModel(env, anchored, { width: 1344, height: 576, references: refs });
	// 384px for the per-frame critic; 640px for continuity, where hair and clothing need to be legible
	const [frame, preview, detail] = await Promise.all([
		encode(env, source, "image/webp"),
		encode(env, source, "image/webp", 384),
		encode(env, source, "image/webp", 640),
	]);
	return {
		frame,
		previewBase64: toBase64(preview),
		detailBase64: toBase64(detail),
		meta: {
			model: env.RENDER_MODEL,
			seed,
			attempts,
			width: 1344,
			height: 576,
			references: refs.map((r) => r.path),
			prompt_sent: anchored,
			bytes: { source: source.byteLength, frame_webp: frame.byteLength, preview_webp: preview.byteLength },
			elapsed_ms: Date.now() - started,
		},
	};
}

async function clef(env: Env, state: unknown, images: string[], questions: Record<string, unknown>, model: string = env.CLEF_MODEL) {
	const started = Date.now();
	const input = {
		model,
		state,
		images: images.map((base64) => ({ content_type: "image/webp", base64 })),
		questions,
	};
	const out = (await withRetry(() =>
		env.AI.run(`@cf/cloudflare/${model}` as keyof AiModels, input as never),
	)) as unknown as { answers: Record<string, ClefAnswer> };
	return { answers: out.answers, elapsed_ms: Date.now() - started };
}

/** Clef: typed questions about the frame, answered with probabilities instead of prose. */
export async function review(env: Env, cell: Cell, prompt: string, webpBase64: string) {
	const { answers, elapsed_ms } = await clef(env, { prompt, intended_shot: cell.shot }, [webpBase64], {
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
	});
	return { model: env.CLEF_MODEL, elapsed_ms, adherence: answers.adherence, framing: answers.framing, artifacts: answers.artifacts };
}

/**
 * Continuity critic. Checks the frame against the bible: each character's age and look; hair and outerwear
 * colour compared between the frame and the casting portrait; identity against the portrait when faces
 * are big enough; and framing against the plan. The per-cell critic can't catch these: it only sees its
 * own prompt, which may itself be wrong. The rules live in continuity-rules.ts.
 */
export async function checkContinuity(
	env: Env,
	cell: Cell,
	refs: Reference[],
	detailBase64: string,
	framing: ClefAnswer | undefined,
) {
	const characters = refs.map((r) => r.character);
	if (!characters.length) {
		const { ok, issues } = continuityVerdict(cell, [], {}, framing);
		return { ok, issues, checked: "framing only: no characters in frame" };
	}
	const asked = continuityQuestions(cell, characters);
	const images = [detailBase64, ...refs.slice(0, asked.checked.length).map((r) => r.previewBase64)];
	const { answers, elapsed_ms } = await clef(env, asked.state, images, asked.questions);
	const verdict = continuityVerdict(cell, characters, answers, framing);
	return { ...verdict, identity_checked: asked.identityChecked, model: env.CLEF_MODEL, elapsed_ms, answers };
}

export async function routeNote(env: Env, note: string, cell: Cell, prompt: string | undefined, characters: Character[]) {
	const { state, questions } = routerRequest(note, cell, prompt, characters);
	const { answers, elapsed_ms } = await clef(env, state, [], questions, env.CLEF_ROUTER_MODEL);
	const a = answers.action;
	return {
		action: (a?.choice ?? "rewrite_prompt") as NoteAction,
		probabilities: a?.probabilities ?? {},
		model: env.CLEF_ROUTER_MODEL,
		elapsed_ms,
	};
}

/** Director, revising: applies a note to the shared bible and characters. Returns the full new versions. */
export async function editBible(env: Env, skill: Skill, bible: string, characters: Character[], note: string) {
	const system = `${skill.body}

## Task
You are revising an existing plan, not starting over. Apply the director's note to the style bible and
characters. Change only what the note asks for and keep everything else word for word.

## Output contract
Reply with ONLY a JSON object:
{"changed": boolean, // false if the bible and characters already say what the note asks for
 "summary": string,   // one sentence: what changed
 "bible": string,     // the full markdown style bible: ## Look and ## Locations sections only
 "characters": [{"name": string, "age_band": one of ${Object.keys(AGE_BANDS).join("|")}, "look": string}]}`;
	const user = `NOTE: ${note}

CURRENT BIBLE:
${bible}

CURRENT CHARACTERS:
${JSON.stringify(characters, null, 2)}`;
	const out = extractJson<{ changed?: boolean; summary: string; bible: string; characters: Character[] }>(
		await chat(env, skill.metadata.model ?? env.DIRECTOR_MODEL, system, user),
	);
	const known = new Map(characters.map((c) => [c.name, c]));
	return {
		changed: out.changed !== false,
		summary: out.summary,
		bible: out.bible,
		// Names are keys across the repo (portraits, cells); the director may not add or rename characters here
		characters: characters.map((c) => {
			const next = out.characters?.find((n) => n.name === c.name);
			return next && known.has(next.name)
				? { ...c, look: next.look || c.look, age_band: next.age_band in AGE_BANDS ? next.age_band : c.age_band }
				: c;
		}),
	};
}

/** Blast radius (Clef-flash): one yes/no per cell, in a single call. */
export async function blastRadius(env: Env, change: string, cells: Cell[]) {
	const state = { change, shots: Object.fromEntries(cells.map((c) => [c.id, { beat: c.beat, characters: c.characters }])) };
	const questions = Object.fromEntries(
		cells.map((c) => [
			`affects.${c.id}`,
			{ type: "noul", instructions: `Would \`change\` alter what should be visible in shot \`shots.${c.id}\`?` },
		]),
	);
	const { answers, elapsed_ms } = await clef(env, state, [], questions, env.CLEF_ROUTER_MODEL);
	const p = Object.fromEntries(cells.map((c) => [c.id, answers[`affects.${c.id}`]?.noul ?? 0]));
	return { affected: cells.filter((c) => p[c.id] >= 0.5).map((c) => c.id), probabilities: p, elapsed_ms };
}

/** Showrunner's note on a cell, in its skill's voice: one or two sentences for the cinematographer. */
export async function writeNote(env: Env, skill: Skill, context: string) {
	const system = `${skill.body}

## Output contract
Reply with ONLY the note: one or two sentences, addressed to the cinematographer, about this one shot.`;
	const text = (await chat(env, skill.metadata.model ?? env.DIRECTOR_MODEL, system, context)).trim().replace(/^"|"$/g, "");
	return text.split("\n")[0].slice(0, 400);
}
