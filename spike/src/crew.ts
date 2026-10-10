// The crew: which model fills each slot of a board's pipeline (docs/arena.md, "Crew draft"). Prices are
// Cloudflare's (2026-10); per-use costs assume this pipeline's usage (1344x576 frames, the token counts
// below). Arena showrunners draft a crew within their budget; every other board uses DEFAULT_CREW.
// Pure: unit-tested in test/crew.test.ts.

export interface LlmOption {
	id: string;
	label: string;
	in: number; // USD per M input tokens
	out: number; // USD per M output tokens
	// Reasoning tokens a call typically spends before answering, billed as output
	thinking?: number;
	// The same for a lead's calls, which think hard where the provider allows it (llm.ts)
	leadThinking?: number;
}
export interface RendererOption {
	id: string;
	label: string;
	perFrame: number; // one 1344x576 frame with up to 3 reference images
	perPortrait: number; // one 768x768 casting portrait
	// Reference images it takes at most (the location's and the portraits'); 4 when absent
	maxRefs?: number;
}
export interface CriticOption {
	id: "clef" | "clef-flash";
	label: string;
	perTake: number; // the critic and continuity calls, with images
}
export interface VideoOption {
	id: string;
	label: string;
	// Why the draft can't offer it right now (checked live with POST /debug/animate); absent = available
	unavailable?: string;
	// Some providers take the first frame as base64 bytes rather than a URL
	imageAs: "url" | "base64";
	// Seconds the provider will bill for a clip planned at `seconds`
	billedSeconds: (seconds: number) => number;
	usd: (billed: number) => number;
	// The clip comes with its own soundtrack (ambience, effects), which the mix lays under the score
	audio?: boolean;
}

const LLMS = {
	"gemma-4": { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B: cheap and quick, plainer writing", in: 0.1, out: 0.3, thinking: 800 },
	"llama-3.3-70b": { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B: dependable all-rounder", in: 0.293, out: 2.253 },
	"nemotron-3-120b": { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 3 120B: strong planner, good value", in: 0.5, out: 1.5, thinking: 800 },
	"kimi-k2.6": { id: "@cf/moonshotai/kimi-k2.6", label: "Kimi K2.6: the strongest open model, but slow: a decision can take minutes, and it has timed out", in: 0.95, out: 4.0, thinking: 2000 },
	"gpt-5.4-mini": { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini: a small frontier model, quick", in: 0.75, out: 4.5, thinking: 300, leadThinking: 2000 },
	"gpt-6.1-sol": { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol: OpenAI's frontier model", in: 2.0, out: 10.0, thinking: 800, leadThinking: 3000 },
	"gemini-3.1-pro": { id: "google/gemini-3.1-pro", label: "Gemini 3.1 Pro: Google's frontier model", in: 2.0, out: 12.0, thinking: 800, leadThinking: 3000 },
	"claude-sonnet-5.5": { id: "anthropic/claude-sonnet-5.5", label: "Claude Sonnet 5.5: frontier, fast", in: 2.0, out: 10.0, thinking: 500, leadThinking: 2500 },
	"claude-opus-5.5": { id: "anthropic/claude-opus-5.5", label: "Claude Opus 5.5: Anthropic's most capable model", in: 4.0, out: 20.0, thinking: 1000, leadThinking: 2500 },
} satisfies Record<string, LlmOption>;

const snapUp = (allowed: number[]) => (s: number) => allowed.find((a) => a >= s) ?? allowed[allowed.length - 1];

export const MENU = {
	// Text models, for two slots: `lead` (the director, the showrunner's decisions and notes, bible edits,
	// retrospectives: few calls, the ones that steer) and `llm` (the cinematographer: one call per take).
	// Frontier models are billed through AI Gateway's unified billing (prices from Cloudflare's model
	// catalog, 2026-10-08); each answered through env.AI.run in 2-4 s.
	llm: LLMS,
	lead: LLMS,
	renderer: {
		"flux-2-klein-4b": {
			id: "@cf/black-forest-labs/flux-2-klein-4b",
			label: "FLUX.2 klein 4B: fastest and cheapest, less detail, looser likeness",
			perFrame: 0.002,
			perPortrait: 0.0015,
		},
		"flux-2-klein-9b": {
			id: "@cf/black-forest-labs/flux-2-klein-9b",
			label: "FLUX.2 klein 9B: good detail and strong character likeness",
			perFrame: 0.016,
			perPortrait: 0.016,
		},
		"flux-2-dev": {
			id: "@cf/black-forest-labs/flux-2-dev",
			label: "FLUX.2 dev: the most detail and prompt fidelity, slowest and dearest",
			perFrame: 0.05,
			perPortrait: 0.03,
		},
		// Billed by token: ~1,100 output tokens a 1K image at $120 per million, references ~$0.001 each
		// (2026-10-10). On Opus's round 2 close-up of Theo, the only model of three that put his glasses where
		// the shot said (pushed up, eyes bare); FLUX.2 max drew two pairs, as klein had
		"nano-banana-pro": {
			id: "google/nano-banana-pro",
			label: "Nano Banana Pro: Google's image model; the most cinematic, and follows the shot's details over the references; dearest",
			perFrame: 0.14,
			perPortrait: 0.14,
			maxRefs: 3,
		},
	} satisfies Record<string, RendererOption>,
	critic: {
		"clef-flash": { id: "clef-flash", label: "Clef-flash: cheap continuity checks, misses more", perTake: 0.003 },
		clef: { id: "clef", label: "Clef: sharper continuity checks", perTake: 0.007 },
	} satisfies Record<string, CriticOption>,
	video: {
		"hailuo-2.3-fast": {
			id: "minimax/hailuo-2.3-fast",
			label: "Hailuo 2.3 Fast: cheapest; every clip is at least 6 s, 768p",
			billedSeconds: snapUp([6, 10]),
			usd: (billed) => (billed <= 6 ? 0.19 : 0.32),
			imageAs: "url",
		},
		"veo-3.1-fast": {
			id: "google/veo-3.1-fast",
			label: "Veo 3.1 Fast: realistic motion; clips of 4, 6 or 8 s",
			billedSeconds: snapUp([4, 6, 8]),
			usd: (billed) => billed * 0.08,
			// A URL fails (2002) and a data: URL is "Invalid base64"; raw base64 works
			imageAs: "base64",
			unavailable: "fails (2002) on frames with a prominent realistic person; works on landscapes (2026-10-07)",
		},
		"ltx-2.5-fast": {
			id: "lightricks/ltx-2-5-fast",
			label: "LTX-2.5 Fast: quick renders, short clips",
			billedSeconds: snapUp([2, 3, 4, 5, 6, 8, 10]),
			usd: (billed) => billed * 0.09,
			imageAs: "url",
			unavailable: "the provider rejects requests with \"Insufficient funds\" (Cloudflare's side; 2026-10-07)",
		},
		"wan-2.7-i2v": {
			id: "alibaba/wan-2.7-i2v",
			label: "Wan 2.7: dependable, exact clip lengths",
			billedSeconds: (s) => Math.max(2, Math.min(15, Math.round(s))),
			usd: (billed) => billed * 0.1,
			imageAs: "url",
		},
		"seedance-2.0-fast": {
			id: "bytedance/seedance-2.0-fast",
			label: "Seedance 2.0 Fast: the most cinematic, keeps the wide 21:9 frame; clips at least 4 s",
			billedSeconds: (s) => Math.max(4, Math.min(12, Math.round(s))),
			usd: (billed) => billed * 0.12,
			imageAs: "url",
			unavailable: "refuses first frames that may show a real person (InputImageSensitiveContentDetected); our frames are photoreal",
		},
		"flux-3-video": {
			id: "black-forest-labs/flux-3-video",
			label: "FLUX.3 Video: clips with their own sound (ambience, effects), 5-20 s, keeps the wide 21:9 frame; ~2 minutes a clip",
			billedSeconds: (s) => Math.max(5, Math.min(20, Math.round(s))),
			// Per clip at hd, any length (Cloudflare's model page, 2026-10-08); checked live with sound (114 s for 5 s)
			usd: () => 0.17,
			imageAs: "url",
			audio: true,
		},
		// Premium tiers (Cloudflare's model pages, 2026-10-10), each tried on Opus's round 2 close-up of Maya
		"veo-3.1": {
			id: "google/veo-3.1",
			label: "Veo 3.1: Google's full model, the best motion and faces; clips of 4, 6 or 8 s, dearest",
			billedSeconds: snapUp([4, 6, 8]),
			// $0.20-0.60/s by resolution and sound: 720p without sound is the low end
			usd: (billed) => billed * 0.2,
			imageAs: "base64",
		},
		"runway-gen-4.5": {
			id: "runwayml/gen-4.5",
			label: "Runway Gen-4.5: cinematic, keeps the wide frame; 2-10 s",
			billedSeconds: (s) => Math.max(2, Math.min(10, Math.round(s))),
			usd: (billed) => billed * 0.12,
			imageAs: "base64",
			unavailable: "rejects frames wider than about 2:1 (7003 at once on our 21:9 frames, people or not); a 16:9 crop rendered in 92 s (2026-10-10)",
		},
		"h3-max": {
			id: "minimax/h3-max",
			label: "MiniMax H3 Max: quick (~20 s a clip) and cheap, 768p; clips at least 5 s",
			billedSeconds: (s) => Math.max(5, Math.min(15, Math.round(s))),
			usd: (billed) => billed * 0.08,
			imageAs: "url",
		},
		"seedance-2.5": {
			id: "bytedance/seedance-2.5",
			label: "Seedance 2.5: cinematic, with an optional last frame",
			billedSeconds: (s) => Math.max(4, Math.min(12, Math.round(s))),
			usd: (billed) => billed * 0.2312,
			imageAs: "url",
			unavailable: "refuses frames with a realistic person (7003 on a close-up); an empty corridor rendered in 144 s (2026-10-10)",
		},
		"grok-imagine-video": {
			id: "xai/grok-imagine-video",
			label: "Grok Imagine Video: clips with dialogue, effects and music of their own",
			billedSeconds: (s) => Math.max(1, Math.min(15, Math.round(s))),
			usd: (billed) => billed * 0.07,
			imageAs: "url",
			audio: true,
			unavailable: "every request fails with 7003, including the catalog's own text-to-video example (2026-10-08)",
		},
	} satisfies Record<string, VideoOption>,
};

// Nano Banana Pro takes an aspect ratio, not a size: the nearest it offers
const RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const nearestRatio = (width: number, height: number) =>
	RATIOS.reduce((best, r) => {
		const [w, h] = r.split(":").map(Number);
		const [bw, bh] = best.split(":").map(Number);
		return Math.abs(Math.log(w / h / (width / height))) < Math.abs(Math.log(bw / bh / (width / height))) ? r : best;
	});

export type Slot = keyof typeof MENU;

/** Every option on the menu as the UI's Models page shows it (GET /menu): its price in words, and why it's off. */
export function menuView() {
	const price = (slot: string, o: Record<string, unknown>) => {
		if (slot === "lead" || slot === "llm") return `$${o.in} in, $${o.out} out per million tokens`;
		if (slot === "renderer") return `$${(o.perFrame as number).toFixed(3)} a frame, $${(o.perPortrait as number).toFixed(3)} a portrait`;
		if (slot === "critic") return `$${(o.perTake as number).toFixed(3)} a take`;
		const v = o as unknown as VideoOption;
		return `$${v.usd(v.billedSeconds(5)).toFixed(2)} a 5 s clip (billed ${v.billedSeconds(5)} s)`;
	};
	return Object.fromEntries(
		(Object.keys(MENU) as (keyof typeof MENU)[]).map((slot) => [
			slot,
			Object.entries(MENU[slot]).map(([key, option]) => {
				const o = option as unknown as Record<string, unknown>;
				return {
					key,
					id: o.id as string,
					label: o.label as string,
					price: price(slot, o),
					...(o.audio ? { audio: true } : {}),
					...(o.unavailable ? { unavailable: o.unavailable as string } : {}),
				};
			}),
		]),
	);
}
export const SLOTS = Object.keys(MENU) as Slot[];
export type Crew = { [S in Slot]: keyof (typeof MENU)[S] & string };

/** Today's pipeline: what every board used before the draft, and what non-arena boards still use. */
export const DEFAULT_CREW: Crew = { llm: "llama-3.3-70b", lead: "llama-3.3-70b", renderer: "flux-2-klein-9b", critic: "clef", video: "wan-2.7-i2v" };

/** Options the draft may offer for a slot: everything except video models that don't work right now. */
export function draftOptions(slot: Slot): string[] {
	return Object.entries(MENU[slot])
		.filter(([, o]) => !(o as Partial<VideoOption>).unavailable)
		.map(([key]) => key);
}

export const isCrew = (c: unknown): c is Crew =>
	typeof c === "object" && c !== null && SLOTS.every((s) => (c as Record<string, string>)[s] in MENU[s]);

/** A crew from board.json; crews drafted before the lead slot existed used their one LLM for everything. */
export function crewFrom(c: unknown): Crew | undefined {
	if (typeof c !== "object" || c === null) return undefined;
	const filled = { ...(c as Record<string, string>) };
	filled.lead ??= filled.llm;
	return isCrew(filled) ? filled : undefined;
}

// Token budgets of this pipeline's LLM calls (input, output). A turn is the showrunner's decision: the
// board, its history and the tool manual in, an action (perhaps with a note) out.
const CALLS = { director: [2000, 1200], cinematographer: [1200, 200], turn: [5000, 300], revision: [1500, 800] } as const;
// Which slot makes each call: the cinematographer is the per-take writer; everything else is the lead
const SLOT_OF = { director: "lead", cinematographer: "llm", turn: "lead", revision: "lead" } as const;
const llmCall = (crew: Crew, call: keyof typeof CALLS) => {
	const m: LlmOption = MENU[SLOT_OF[call]][crew[SLOT_OF[call]]];
	const thinking = SLOT_OF[call] === "lead" ? (m.leadThinking ?? m.thinking) : m.thinking;
	return (CALLS[call][0] * m.in + (CALLS[call][1] + (thinking ?? 0)) * m.out) / 1e6;
};
// Clef routing (notes router, showrunner decisions, blast radius) is the arena's fixed model
const ROUTER = 0.002;
const CHARACTERS = 2;
// Location scouting: one establishing image per location, typically two
const LOCATIONS = 2;

// A frame edit (D42): FLUX.2 max, which on Theo's two pairs of glasses removed one and changed nothing else.
// Billed by megapixel: $0.07 for the first out, $0.03 for the frame in (2026-10-10)
export const EDIT_MODEL = "black-forest-labs/flux-2-max";
export const EDIT_USD = 0.1;

/** What each kind of job costs with this crew, in USD. */
export function crewCosts(crew: Crew) {
	const renderer: RendererOption = MENU.renderer[crew.renderer];
	const critic: CriticOption = MENU.critic[crew.critic];
	return {
		board: llmCall(crew, "director") + (CHARACTERS + LOCATIONS) * renderer.perPortrait,
		take: renderer.perFrame + llmCall(crew, "cinematographer") + critic.perTake,
		// An edit has no cinematographer and no render, but is reviewed like any take
		edit: EDIT_USD + critic.perTake,
		bible: llmCall(crew, "revision") + renderer.perPortrait + ROUTER,
		turn: llmCall(crew, "turn"),
	};
}

/** A clip's billed length and price with this crew's video model. */
export function clipCost(crew: Crew, seconds: number) {
	const video: VideoOption = MENU.video[crew.video];
	const billed = video.billedSeconds(seconds);
	return { billed, usd: video.usd(billed) };
}

/** The cheapest complete film: plan, one take per cell, a few turns, and the required cut. */
export function cheapestFilm(crew: Crew, clipSeconds: number[], turns = 8) {
	const c = crewCosts(crew);
	const video = clipSeconds.reduce((sum, s) => sum + clipCost(crew, s).usd, 0);
	return c.board + clipSeconds.length * c.take + turns * c.turn + video;
}

/**
 * Makes a drafted crew affordable: while its cheapest complete film exceeds `share` of the budget,
 * downgrade the slot whose next-cheaper option saves the most; `fixed` slots (a season's pinned lead) are
 * never changed. Returns the crew and what changed.
 */
export function fitToBudget(crew: Crew, clipSeconds: number[], budget: number, share = 0.8, fixed: Slot[] = []) {
	const changes: string[] = [];
	let current = { ...crew };
	// Options cheaper than the current one, cheapest first; by price, since the current one may no longer be on
	// the menu (a crew drafted before its model became unavailable)
	const cheaperOptions = (slot: Slot) => {
		const cost = (key: string) => cheapestFilm({ ...current, [slot]: key }, clipSeconds);
		const now = cost(current[slot]);
		return draftOptions(slot).filter((k) => cost(k) < now).sort((a, b) => cost(a) - cost(b));
	};
	while (cheapestFilm(current, clipSeconds) > budget * share) {
		let best: { slot: Slot; option: string; saves: number } | undefined;
		for (const slot of SLOTS.filter((s) => !fixed.includes(s))) {
			const options = cheaperOptions(slot);
			const next = options[options.length - 1];
			if (!next) continue;
			const saves = cheapestFilm(current, clipSeconds) - cheapestFilm({ ...current, [slot]: next }, clipSeconds);
			if (!best || saves > best.saves) best = { slot, option: next, saves };
		}
		if (!best) break;
		changes.push(`${best.slot}: ${current[best.slot]} → ${best.option}`);
		current = { ...current, [best.slot]: best.option } as Crew;
	}
	return { crew: current, changes, film: cheapestFilm(current, clipSeconds) };
}

/** The image-to-video request for a crew's video model: each provider names its inputs differently. */
export function videoRequest(
	crew: Crew,
	image: { url: string; base64?: string },
	prompt: string,
	seconds: number,
	opts: { seed: number; staticCamera: boolean },
) {
	const video: VideoOption = MENU.video[crew.video];
	const billed = video.billedSeconds(seconds);
	const base = { prompt };
	if (video.imageAs === "base64" && !image.base64) throw new Error(`${crew.video} needs the frame as base64`);
	const imageUrl = image.url;
	const input: Record<string, unknown> = (() => {
		switch (crew.video) {
			case "hailuo-2.3-fast":
				return { ...base, first_frame_image: imageUrl, duration: billed, resolution: "768P", prompt_optimizer: false, fast_pretreatment: false };
			case "veo-3.1-fast":
				return { ...base, image_input: image.base64, duration: `${billed}s`, aspect_ratio: "16:9", resolution: "720p", generate_audio: false };
			case "ltx-2.5-fast":
				return { ...base, image_uri: imageUrl, duration: billed, resolution: "1280x720", fps: 24, generate_audio: false };
			case "seedance-2.0-fast":
				return {
					...base,
					image: imageUrl,
					duration: billed,
					resolution: "720p",
					aspect_ratio: "21:9",
					fps: 24,
					camera_fixed: opts.staticCamera,
					watermark: false,
					seed: opts.seed,
					use_virtual_avatar: false,
				};
			case "wan-2.7-i2v":
				return { ...base, image: imageUrl, duration: billed, resolution: "720P", seed: opts.seed, watermark: false };
			case "flux-3-video":
				return { mode: "i2v", prompt, keyframes: imageUrl, duration: billed, aspect_ratio: "21:9", resolution: "hd", generate_audio: true };
			case "grok-imagine-video":
				return { ...base, image: { url: imageUrl }, duration: billed, aspect_ratio: "16:9", resolution: "720p" };
			case "veo-3.1":
				return { ...base, image_input: image.base64, duration: `${billed}s`, aspect_ratio: "16:9", resolution: "720p", generate_audio: false };
			case "runway-gen-4.5":
				return { ...base, image_input: `data:image/jpeg;base64,${image.base64}`, duration: billed, ratio: "1584:672", seed: opts.seed };
			case "h3-max":
				return {
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: imageUrl }, role: "first_frame" },
					],
					duration: billed,
					resolution: "768P",
					ratio: "adaptive",
					extra: { prompt_expansion_mode: "disabled" },
				};
			case "seedance-2.5":
				return { ...base, image: imageUrl, duration: billed, resolution: "720p", generate_audio: false, seed: opts.seed, watermark: false };
		}
	})();
	return { model: video.id, input, billed, usd: video.usd(billed) };
}
