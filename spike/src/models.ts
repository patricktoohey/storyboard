// The model roles from docs/design.md: director, casting, cinematographer, renderer, critic, continuity.
// Director, cinematographer and casting take their craft from a skill in the board repo (skills.ts);
// what stays here is each role's output contract, which code depends on.
import { type Skill, promptTemplate } from "./skills";

export const SHOT_SIZES = {
	EWS: "Extreme wide shot: location dominates, figures tiny",
	WS: "Wide shot: full body with surroundings",
	MS: "Medium shot: waist up",
	CU: "Close-up: face or a single object fills the frame",
	ECU: "Extreme close-up: a detail such as eyes, hands, text",
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;
const SHOT_ORDER = Object.keys(SHOT_SIZES) as ShotSize[];
// Shots where a face is the subject: casting portraits are passed as identity references and identity is
// checked. Wider shots make faces too small to judge, ECUs are details, and in both a head-and-shoulders
// reference drags the composition toward a medium shot.
const PORTRAIT_SHOTS: ShotSize[] = ["MS", "CU"];
export const usesPortraits = (shot: ShotSize) => PORTRAIT_SHOTS.includes(shot);

export const AGE_BANDS = {
	child: "Under 13",
	teen: "13 to 19",
	young_adult: "20 to 35",
	middle_aged: "36 to 59",
	elderly: "60 and older",
} as const;
export type AgeBand = keyof typeof AGE_BANDS;
const AGE_ORDER = Object.keys(AGE_BANDS) as AgeBand[];
const AGE_WORDS: Record<AgeBand, string> = {
	child: "young child",
	teen: "teenage",
	young_adult: "young adult",
	middle_aged: "middle-aged",
	elderly: "elderly",
};

export interface Character {
	name: string;
	age_band: AgeBand;
	// Visual description pasted verbatim into every prompt the character appears in
	look: string;
}

export interface Cell {
	id: string;
	beat: string;
	shot: ShotSize;
	camera: string;
	duration_s: number;
	characters: string[];
}

export interface Board {
	title: string;
	bible: string;
	characters: Character[];
	cells: Cell[];
}

/** A character's casting portrait: the identity anchor for rendering and for continuity checks. */
export interface Reference {
	character: Character;
	path: string;
	// <512px JPEG: flux-2 reference inputs must be smaller than 512x512
	jpeg: Uint8Array;
	previewBase64: string;
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The image model knows nothing about names, so every character in the frame must be described
 * with its bible `look`, word for word. The LLM writes {{Name}} placeholders; code does the pasting.
 */
export function insertLooks(prompt: string, cast: Character[]) {
	let out = prompt;
	for (const c of cast) {
		// First mention gets the full look ("{{Maren}}'s face" -> "<look>, whose face"); later ones
		// stay grammatical without repeating it
		let first = true;
		out = out.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(c.name)}\\s*\\}\\}(['’]s\\b)?`, "gi"), (_m, possessive) => {
			const text = first ? `${c.look}${possessive ? ", whose" : ""}` : `the same person${possessive ? "'s" : ""}`;
			first = false;
			return text;
		});
		// The model ignored the placeholder: append the look rather than trusting a bare name
		if (!out.includes(c.look)) out = `${out.replace(/[.\s]+$/, "")}. Featuring ${c.look}.`;
	}
	return out.replace(/\{\{[^}]*\}\}/g, "");
}

export async function cinematograph(
	env: Env,
	skill: Skill,
	bible: string,
	cast: Character[],
	cell: Cell,
	continuityNote?: string,
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
	if (continuityNote) brief.push(`The previous take was rejected: ${continuityNote}. Fix that.`);
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
	const [frame, preview] = await Promise.all([encode(env, source, "image/webp"), encode(env, source, "image/webp", 384)]);
	return {
		frame,
		previewBase64: toBase64(preview),
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

type ClefAnswer = { noul?: number; choice?: string; score?: number; probabilities?: Record<string, number> };

async function clef(env: Env, state: unknown, images: string[], questions: Record<string, unknown>) {
	const started = Date.now();
	const input = {
		model: env.CLEF_MODEL,
		state,
		images: images.map((base64) => ({ content_type: "image/webp", base64 })),
		questions,
	};
	const out = (await withRetry(() =>
		env.AI.run(`@cf/cloudflare/${env.CLEF_MODEL}` as keyof AiModels, input as never),
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
 * Continuity critic. Checks the frame against the bible: each character's age and look, and (when
 * faces are big enough) identity against the casting portrait. Also flags framing far from the plan.
 * The per-cell critic can't catch these: it only sees its own prompt, which may itself be wrong.
 */
export async function checkContinuity(
	env: Env,
	cell: Cell,
	refs: Reference[],
	previewBase64: string,
	framing: ClefAnswer | undefined,
) {
	const issues: string[] = [];
	const seenShot = framing?.choice as ShotSize | undefined;
	if (seenShot && Math.abs(SHOT_ORDER.indexOf(seenShot) - SHOT_ORDER.indexOf(cell.shot)) > 1) {
		issues.push(`framing reads as ${seenShot} but the shot is ${cell.shot} (${SHOT_SIZES[cell.shot]})`);
	}
	if (!refs.length) return { ok: issues.length === 0, issues, checked: "framing only: no characters in frame" };

	const state = { beat: cell.beat, characters: Object.fromEntries(refs.map((r) => [r.character.name, r.character.look])) };
	const images = [previewBase64];
	const questions: Record<string, unknown> = {};
	const faces = usesPortraits(cell.shot);
	for (const r of refs) {
		const c = r.character;
		questions[`age.${slug(c.name)}`] = {
			type: "choice",
			instructions: `Find the person in the first image who is most likely \`characters.${c.name}\`. What is their apparent age?`,
			criteria: AGE_BANDS,
		};
		questions[`look.${slug(c.name)}`] = {
			type: "noul",
			instructions: `Does the first image show a person matching \`characters.${c.name}\` (age, hair, build and wardrobe)?`,
		};
		if (faces && images.length < 4) {
			images.push(r.previewBase64);
			questions[`identity.${slug(c.name)}`] = {
				type: "noul",
				instructions: `Image ${images.length} is the casting portrait of \`characters.${c.name}\`. Is that same individual (same face, age and hair) in the first image?`,
			};
		}
	}

	const { answers, elapsed_ms } = await clef(env, state, images, questions);
	for (const r of refs) {
		const c = r.character;
		const seen = answers[`age.${slug(c.name)}`]?.choice as AgeBand | undefined;
		// Adjacent bands pass: "late 50s" reading as elderly is not a continuity break
		if (seen && Math.abs(AGE_ORDER.indexOf(seen) - AGE_ORDER.indexOf(c.age_band)) > 1) {
			issues.push(`${c.name} reads as ${AGE_WORDS[seen]} but should be ${AGE_WORDS[c.age_band]}`);
		}
		const look = answers[`look.${slug(c.name)}`]?.noul ?? 1;
		if (look < 0.5) issues.push(`${c.name} does not match "${c.look}" (p=${look.toFixed(2)})`);
		const identity = answers[`identity.${slug(c.name)}`]?.noul;
		if (identity !== undefined && identity < 0.5) {
			issues.push(`${c.name} is not the same person as in the casting portrait (p=${identity.toFixed(2)})`);
		}
	}
	return { ok: issues.length === 0, issues, identity_checked: faces, model: env.CLEF_MODEL, elapsed_ms, answers };
}
