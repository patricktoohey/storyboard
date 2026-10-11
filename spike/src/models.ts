// The model roles from docs/design.md: director, casting, cinematographer, renderer, critic, continuity.
// Director, cinematographer and casting take their craft from a skill in the board repo (skills.ts);
// what stays here is each role's output contract, which code depends on.
import { IMPOSSIBLE_QUESTION, SETTING_SHOTS, continuityQuestions, continuityVerdict } from "./continuity-rules.ts";
import { llmFor } from "./crew-env";
import { EDIT_MODEL, MENU, type RendererOption, nearestRatio } from "./crew.ts";
import { RATE_LIMITED, llmRequest, llmText, llmUsage, retryDelay } from "./llm.ts";
import { normalizePositions, withBlocking, withStaged } from "./blocking.ts";
import { insertLooks } from "./looks";
import { type NoteAction, routerRequest } from "./router.ts";
import { type Skill, promptTemplate } from "./skills";
import {
	type Board,
	type Cell,
	type Character,
	type ClefAnswer,
	type Location,
	type LocationReference,
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
export const TRANSIENT = ["3040", "3043"];

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, retryOn = TRANSIENT, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn(attempt);
		} catch (err) {
			if (attempt >= attempts || !retryOn.some((code) => String(err).includes(code))) throw err;
			await new Promise((r) => setTimeout(r, retryDelay(err, attempt)));
		}
	}
}

/** The lead's calls (direction, bible edits, notes, retrospectives) think hard; the per-take writing doesn't. */
async function chat(env: Env, model: string, system: string, user: string, maxTokens = 8192): Promise<string> {
	return (await ask(env, model, system, user, maxTokens, model === env.DIRECTOR_MODEL)).text;
}

/** A text model's answer with the tokens it used (for billing what a call really cost). */
export async function ask(env: Env, model: string, system: string, user: string, maxTokens = 8192, think = false): Promise<{ text: string; usage: { input: number; output: number } }> {
	// Reasoning models (Gemma 4, Kimi, GPT, Claude with thinking) think in the same token budget: at 2048 the
	// director's plan came back empty, all of it spent on reasoning
	const out = await withRetry(() => env.AI.run(model as keyof AiModels, llmRequest(model, system, user, maxTokens, think) as never), [...TRANSIENT, RATE_LIMITED]);
	const text = llmText(out);
	const usage = llmUsage(out);
	if (text.trim()) return { text, usage };
	// Empty: the reasoning used the whole budget. Kimi did this at 8192 once the plan gained locations and
	// blocking (season-2026-10-08-0a8064, round 1); one retry with double the room
	if (maxTokens < 16384) {
		const again = await ask(env, model, system, user, maxTokens * 2, think);
		return { text: again.text, usage: { input: usage.input + again.usage.input, output: usage.output + again.usage.output } };
	}
	throw new Error(`${model} returned no text: ${JSON.stringify(out).slice(0, 200)}`);
}

/** A raw call for POST /debug/llm: what a provider actually returns, and how long it took. */
export async function probeLlm(env: Env, model: string, system: string, user: string, maxTokens = 1024, think = false, extra: Record<string, unknown> = {}) {
	const started = Date.now();
	// `extra` fields go on the request as they are: for checking what a provider accepts through the binding
	const out = await env.AI.run(model as keyof AiModels, { ...llmRequest(model, system, user, maxTokens, think), ...extra } as never);
	return { model, ms: Date.now() - started, text: llmText(out), usage: llmUsage(out), raw: JSON.stringify(out).slice(0, 1500) };
}

/**
 * A JSON answer, with one correction: an answer that doesn't parse is sent back with the parser's error.
 * Llama's first retrospective put markdown bullets inside a JSON array and the team kept its old strategy.
 */
async function chatJson<T>(env: Env, model: string, system: string, user: string): Promise<T> {
	const text = await chat(env, model, system, user);
	try {
		return extractJson<T>(text);
	} catch (err) {
		const again = await chat(env, model, system, `${user}\n\nYour last reply was not valid JSON (${String(err).slice(0, 160)}). Reply again with ONLY the JSON object.`);
		return extractJson<T>(again);
	}
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
 "bible": string,  // markdown style bible: ## Look (format, palette, light, lenses)
 "locations": [{"name": string,
                "look": string}],  // under 30 words of visual facts: the place, its architecture and layout, key props, light and time of day
 "characters": [{"name": string, "age_band": one of ${Object.keys(AGE_BANDS).join("|")},
                 "look": string}],  // under 30 words of visual facts only, starting with exact age and sex ("58-year-old woman, ..."), then face, hair, build, wardrobe
 "cells": [{"beat": string, "shot": one of ${SHOT_ORDER.join("|")}, "camera": string, "duration_s": number,
            "characters": [names of characters visible in the frame],
            "location": name of one of the locations,
            "blocking": string,  // one sentence: where each person is and what they face, e.g. "Driver at the wheel facing forward; passenger behind her, leaning in"
            "positions": {character name: "left" | "center" | "right"}}]}  // where each character is in the frame; keep sides consistent between shots in the same place
Write exactly ${cellCount} cells.`;
	const board = await chatJson<Omit<Board, "cells"> & { cells: Omit<Cell, "id">[] }>(env, llmFor(env, skill.metadata.model, env.DIRECTOR_MODEL), system, concept);
	const characters = (board.characters ?? []).map((c) => {
		const age_band = c.age_band in AGE_BANDS ? c.age_band : "young_adult";
		// Age must be in the look itself; "worn face" alone renders as 30
		const statesAge = /\d|child|teen|young|middle|elderly|old/i.test(c.look);
		return { ...c, age_band, look: statesAge ? c.look : `${AGE_WORDS[age_band]} ${c.look}` };
	});
	const known = new Set(characters.map((c) => c.name));
	const locations = (board.locations ?? []).filter((l) => l?.name && l?.look).slice(0, 3);
	const places = new Set(locations.map((l) => l.name));
	return {
		title: board.title,
		bible: board.bible,
		characters,
		locations,
		cells: board.cells.slice(0, cellCount).map((c, i) => {
			const blocking = typeof c.blocking === "string" ? c.blocking.slice(0, 300) : undefined;
			// Anyone the blocking stages is in the shot, even if the director left them off the list
			const inShot = withStaged((c.characters ?? []).filter((n) => known.has(n)), blocking, [...known]);
			return {
				...c,
				id: String(i + 1).padStart(2, "0"),
				shot: c.shot in SHOT_SIZES ? c.shot : "MS",
				characters: inShot,
				location: c.location && places.has(c.location) ? c.location : locations[0]?.name,
				blocking,
				positions: normalizePositions(c.positions, inShot),
			};
		}),
	};
}

export async function cinematograph(
	env: Env,
	skill: Skill,
	bible: string,
	cast: Character[],
	cell: Cell,
	direction?: string,
	staging?: string,
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
${staging ? `\n## Staging (follow exactly; describe the place as written)\n${staging}\n` : ""}
## Style bible
${bible}`;
	const brief = [`Beat: ${cell.beat}`, `Camera: ${cell.camera}`];
	if (direction) brief.push(direction);
	const draft = (await chat(env, llmFor(env, skill.metadata.model, env.CINEMATOGRAPHER_MODEL), system, brief.join("\n")))
		.trim()
		.replace(/^"|"$/g, "");
	// The blocking goes in once more in plain words: the LLM tends to drop depth and keep only left/right
	return withBlocking(insertLooks(draft, cast), cell, cast);
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
	references?: { jpeg: Uint8Array }[];
}

/** Each attempt gets a fresh seed, so a flagged output (3030) can come out clean on retry. */
// When a renderer keeps failing, the next lighter one shoots instead (D36): in the format dry run's second
// round flux-2-dev answered portraits but failed every full-size shot with references for 34 minutes (3043),
// and no team printed anything
export const RENDER_FALLBACK: Record<string, string> = {
	"@cf/black-forest-labs/flux-2-dev": "@cf/black-forest-labs/flux-2-klein-9b",
	"@cf/black-forest-labs/flux-2-klein-9b": "@cf/black-forest-labs/flux-2-klein-4b",
	"google/nano-banana-pro": "@cf/black-forest-labs/flux-2-dev",
};


async function runImageModel(env: Env, prompt: string, opts: RenderOptions) {
	let model: string = env.RENDER_MODEL;
	for (;;) {
		try {
			return await withRetry(async (attempt) => {
				const seed = randomSeed();
				return { bytes: await runImageModelOnce(env, model, prompt, { ...opts, seed }), seed, attempts: attempt, model };
			// With a lighter model to hand, a minute of rate limiting is enough: two teams on flux-2-dev lost twelve
			// takes to its per-minute limit in Season 2's round 1, after five minutes of retries each
			}, [...TRANSIENT, "3030", RATE_LIMITED], RENDER_FALLBACK[model] ? 3 : 6);
		} catch (err) {
			const next = RENDER_FALLBACK[model];
			if (!next || ![...TRANSIENT, RATE_LIMITED].some((code) => String(err).includes(code))) throw err;
			console.warn(`${model} failing (${String(err).slice(0, 80)}); rendering with ${next}`);
			model = next;
		}
	}
}

/** flux-2 models take multipart form data (and reference images); flux-1-schnell takes JSON with no seed. */
async function runImageModelOnce(env: Env, model: string, prompt: string, opts: RenderOptions & { seed: number }) {
	let out: { image: string };
	if (model === "google/nano-banana-pro") {
		const res = (await env.AI.run(model as keyof AiModels, {
			prompt,
			aspect_ratio: nearestRatio(opts.width, opts.height),
			image_size: "1K",
			output_format: "jpg",
			...(opts.references?.length ? { image_input: opts.references.slice(0, 3).map((r) => `data:image/jpeg;base64,${toBase64(r.jpeg)}`) } : {}),
		} as never)) as unknown as { image?: string; result?: { image?: string } };
		// A URL to the image (the gateway's output store), bare or wrapped in { state, result }
		const url = res?.image ?? res?.result?.image;
		if (!url) throw new Error(`${model} returned no image: ${JSON.stringify(res).slice(0, 200)}`);
		if (!url.startsWith("http")) return Uint8Array.from(atob(url), (c) => c.charCodeAt(0));
		const img = await fetch(url);
		if (!img.ok) throw new Error(`downloading the image failed: ${img.status}`);
		return new Uint8Array(await img.arrayBuffer());
	}
	if (model.includes("flux-2")) {
		const form = new FormData();
		form.append("prompt", prompt);
		form.append("width", String(opts.width));
		form.append("height", String(opts.height));
		form.append("seed", String(opts.seed));
		opts.references?.forEach((r, i) => form.append(`input_image_${i}`, new Blob([r.jpeg], { type: "image/jpeg" })));
		const body = new Response(form);
		out = (await env.AI.run(model as keyof AiModels, {
			multipart: { body: body.body, contentType: body.headers.get("content-type") },
		} as never)) as unknown as { image: string };
	} else {
		out = (await env.AI.run(model as keyof AiModels, { prompt, steps: 4 } as never)) as unknown as {
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

/** Location scouting: one wide, empty establishing image per location, the anchor for its sets. */
export async function scout(env: Env, skill: Skill, location: Location) {
	const prompt = promptTemplate(skill, "location").replace("{{look}}", location.look);
	const { bytes: source } = await runImageModel(env, prompt, { width: 1024, height: 448 });
	const [webp, reference] = await Promise.all([encode(env, source, "image/webp"), locationReference(env, location, source)]);
	return { ...reference, webp };
}

export const locationPath = (location: Location) => `bible/locations/${slug(location.name)}.webp`;

export async function locationReference(env: Env, location: Location, image: Uint8Array): Promise<LocationReference> {
	const [jpeg, preview] = await Promise.all([encode(env, image, "image/jpeg", 496), encode(env, image, "image/webp", 384)]);
	return { location, path: locationPath(location), jpeg, previewBase64: toBase64(preview) };
}

export const portraitPath = (character: Character) => `bible/refs/${slug(character.name)}.webp`;

/** Turns a portrait (fresh from casting, or read back from the repo) into render and Clef inputs. */
export async function portraitReference(env: Env, character: Character, image: Uint8Array): Promise<Reference> {
	const [jpeg, preview] = await Promise.all([encode(env, image, "image/jpeg", 496), encode(env, image, "image/webp", 384)]);
	return { character, path: portraitPath(character), jpeg, previewBase64: toBase64(preview) };
}

export async function render(env: Env, cell: Cell, prompt: string, references: Reference[], location?: LocationReference) {
	const started = Date.now();
	// The location's reference anchors the set for shots wide enough to show it; portraits anchor faces
	const place = location && SETTING_SHOTS.includes(cell.shot) ? location : undefined;
	const most = (Object.values(MENU.renderer) as RendererOption[]).find((r) => r.id === env.RENDER_MODEL)?.maxRefs ?? 4;
	const refs = usesPortraits(cell.shot) ? references.slice(0, place ? most - 1 : most) : [];
	// Image models don't know "EWS"; spell the framing out first
	const framed = `${SHOT_SIZES[cell.shot]}. ${prompt}`;
	// Tie each reference image to the description it anchors
	const offset = place ? 1 : 0;
	const anchors = [
		...(place ? [`The setting is the place in image 0: keep its architecture, layout, props and light.`] : []),
		...refs.map((r, i) => `The ${r.character.look.split(",")[0]} is the person in image ${i + offset}: keep the same face, hair and wardrobe.`),
	];
	// Theo's look said "black-rimmed glasses" and his shot "glasses pushed up on his forehead": klein and
	// FLUX.2 max drew both pairs. The shot is the newer instruction
	if (refs.length) anchors.push("Where this shot's description changes how someone wears or holds something, follow the description, not the reference image.");
	const anchored = anchors.length ? `${framed} ${anchors.join(" ")}` : framed;
	// 1344x576 is close to 2.39:1 anamorphic and divisible by 16
	const { bytes: source, seed, attempts, model } = await runImageModel(env, anchored, { width: 1344, height: 576, references: [...(place ? [place] : []), ...refs] });
	// 384px for the per-frame critic; 640px for continuity, where hair and clothing need to be legible
	// Nano Banana Pro's 21:9 is 1584x672: every frame is stored at most 1344 wide, like the rest
	const [frame, preview, detail] = await Promise.all([
		encode(env, source, "image/webp", 1344),
		encode(env, source, "image/webp", 384),
		encode(env, source, "image/webp", 640),
	]);
	return {
		frame,
		previewBase64: toBase64(preview),
		detailBase64: toBase64(detail),
		meta: {
			model,
			...(model !== env.RENDER_MODEL ? { fell_back_from: env.RENDER_MODEL } : {}),
			seed,
			attempts,
			width: 1344,
			height: 576,
			references: [...(place ? [place.path] : []), ...refs.map((r) => r.path)],
			prompt_sent: anchored,
			bytes: { source: source.byteLength, frame_webp: frame.byteLength, preview_webp: preview.byteLength },
			elapsed_ms: Date.now() - started,
		},
	};
}

/**
 * A frame edited, not shot again (D42): the edit model gets the frame and the instruction, and is told to
 * change nothing else. Same outputs as render(), so the critic and the continuity check judge it as a take.
 */
export async function editFrame(env: Env, source: Uint8Array, instruction: string) {
	const started = Date.now();
	const prompt = `Edit this film frame: ${instruction.trim().replace(/\.?$/, ".")} Change nothing else: keep every face, expression, wardrobe item, prop, the light, the framing and any text exactly as they are.`;
	const jpeg = await encode(env, source, "image/jpeg", 1344);
	const { result, attempts } = await withRetry(async (attempt) => {
		const out = (await env.AI.run(EDIT_MODEL as keyof AiModels, {
			prompt,
			width: 1344,
			height: 576,
			input_images: [`data:image/jpeg;base64,${toBase64(jpeg)}`],
			output_format: "jpeg",
		} as never)) as unknown as { image?: string; result?: { image?: string } };
		const url = out?.image ?? out?.result?.image;
		if (!url) throw new Error(`${EDIT_MODEL} returned no image: ${JSON.stringify(out).slice(0, 200)}`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`downloading the edit failed: ${res.status}`);
		return { result: new Uint8Array(await res.arrayBuffer()), attempts: attempt };
	}, [...TRANSIENT, RATE_LIMITED], 4);
	const [frame, preview, detail] = await Promise.all([
		encode(env, result, "image/webp", 1344),
		encode(env, result, "image/webp", 384),
		encode(env, result, "image/webp", 640),
	]);
	return {
		frame,
		previewBase64: toBase64(preview),
		detailBase64: toBase64(detail),
		meta: { model: EDIT_MODEL, attempts, width: 1344, height: 576, prompt_sent: prompt, bytes: { frame_webp: frame.byteLength }, elapsed_ms: Date.now() - started },
	};
}

/**
 * A printed shot rendered again with another renderer, from the prompt and references it was shot with, for
 * comparing renderers (POST /debug/render). Nothing is committed.
 */
export async function rerender(env: Env, repo: string, cell: string, renderer: keyof typeof MENU.renderer) {
	using handle = await env.ARTIFACTS.get(repo);
	const read = async (path: string) => {
		const blob = await handle.readFile({ ref: "main", path });
		if (!blob) throw new Error(`${repo} has no ${path}`);
		return new Uint8Array(await new Response(blob.stream()).arrayBuffer());
	};
	const meta = JSON.parse(new TextDecoder().decode(await read(`cells/${cell}/render.json`))) as { prompt_sent: string; references?: string[] };
	const option: RendererOption = MENU.renderer[renderer];
	const paths = (meta.references ?? []).slice(0, option.maxRefs ?? 4);
	const references = await Promise.all(paths.map(async (p) => ({ jpeg: await encode(env, await read(p), "image/jpeg", 496) })));
	const prompt = references.length && !meta.prompt_sent.includes("follow the description")
		? `${meta.prompt_sent} Where this shot's description changes how someone wears or holds something, follow the description, not the reference image.`
		: meta.prompt_sent;
	const started = Date.now();
	const source = await runImageModelOnce(env, option.id, prompt, { width: 1344, height: 576, references, seed: randomSeed() });
	return { jpeg: await encode(env, source, "image/jpeg", 1344), ms: Date.now() - started, references: paths };
}

async function clef(env: Env, state: unknown, images: string[], questions: Record<string, unknown>, model: string = env.CLEF_MODEL) {
	const started = Date.now();
	const input = {
		model,
		state,
		images: images.map((base64) => ({ content_type: "image/webp", base64 })),
		questions,
	};
	// 5012 "Clef inference failed" came and went within a minute in the first frontier arena. A burst of ideas
	// and a replan (twenty takes, two or three Clef calls each) hit the per-minute limit in the D38 dry run
	const out = (await withRetry(() => env.AI.run(`@cf/cloudflare/${model}` as keyof AiModels, input as never), [...TRANSIENT, "5012", RATE_LIMITED], 6)) as unknown as {
		answers: Record<string, ClefAnswer>;
	};
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
	location?: LocationReference,
) {
	const characters = refs.map((r) => r.character);
	// Nothing to compare: no characters, and no location reference for a shot that shows the setting
	if (!characters.length && !(location && SETTING_SHOTS.includes(cell.shot))) {
		const { ok, issues } = continuityVerdict(cell, [], {}, framing);
		return { ok, issues, checked: "framing only: no characters in frame" };
	}
	const asked = continuityQuestions(cell, characters, location?.location);
	const images = [
		detailBase64,
		...(asked.placeChecked && location ? [location.previewBase64] : []),
		...refs.slice(0, asked.checked.length).map((r) => r.previewBase64),
	];
	const { answers, elapsed_ms } = await clef(env, asked.state, images, asked.questions);
	const verdict = continuityVerdict(cell, characters, answers, framing);
	return { ...verdict, identity_checked: asked.identityChecked, model: env.CLEF_MODEL, elapsed_ms, answers };
}

/**
 * The impossible-frame question alone (D44), for a printed frame carried over from a board shot before the
 * question existed: Opus's carried Theo kept both pairs of glasses through the Finale Special.
 */
export async function checkImpossible(env: Env, webp: Uint8Array) {
	const detail = await encode(env, webp, "image/webp", 640);
	const { answers } = await clef(env, {}, [toBase64(detail)], { impossible: { type: "noul", instructions: IMPOSSIBLE_QUESTION } });
	return answers.impossible?.noul;
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
	const out = await chatJson<{ changed?: boolean; summary: string; bible: string; characters: Character[] }>(
		env,
		llmFor(env, skill.metadata.model, env.DIRECTOR_MODEL),
		system,
		user,
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
	const text = (await chat(env, llmFor(env, skill.metadata.model, env.DIRECTOR_MODEL), system, context)).trim().replace(/^"|"$/g, "");
	return text.split("\n")[0].slice(0, 400);
}

export interface Retrospective {
	lessons: string[];
	strategy: string;
	adopt_cinematographer: string | null;
	// An earlier strategy version to return to instead of a rewrite
	revert_to: string | null;
}

/**
 * A showrunner's retrospective after a season round: what it learned, its rewritten strategy, and
 * optionally a rival's cinematographer to adopt. The caller applies it with guardrails (replaceStrategy).
 */
export async function retrospect(env: Env, skill: Skill, context: string): Promise<Retrospective> {
	const system = `${skill.body}

## Task
You lead a team in a season of storyboard competitions. A round has just ended. Study your result, the
judges' comparisons, how you spent your budget and turns, and what your rivals did. Decide what to keep
doing and what to change, then rewrite your strategy for the next round. You may adopt a rival's
cinematographer if theirs clearly worked better; a different brief comes next round, so learn principles,
not this round's story.

Your strategies are versioned: \`your_strategy_history\` has each one beside the round it played and its
result. If an earlier version did better than where you are now, you can return to it exactly
("revert_to": its version) instead of writing a new one; otherwise write the strategy you believe in.

## Output contract
Reply with ONLY a JSON object:
{"lessons": [string, string, string],      // three short, concrete lessons from this round
 "strategy": string,                       // your new "## Strategy" section body: 3 to 6 markdown bullets
 "revert_to": string | null,               // a version from your_strategy_history to return to instead, or null
 "adopt_cinematographer": string | null}  // a cinematographer skill name from the rivals, or null`;
	const out = await chatJson<Retrospective>(env, llmFor(env, skill.metadata.model, env.DIRECTOR_MODEL), system, context);
	return {
		lessons: (out.lessons ?? []).map(String).slice(0, 5),
		strategy: String(out.strategy ?? ""),
		adopt_cinematographer: out.adopt_cinematographer ? String(out.adopt_cinematographer) : null,
		revert_to: out.revert_to ? String(out.revert_to) : null,
	};
}
