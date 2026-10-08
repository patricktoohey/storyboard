// The crew: which model fills each slot of a board's pipeline (docs/arena.md, "Crew draft"). Prices are
// Cloudflare's (2026-10); per-use costs assume this pipeline's usage (1344x576 frames, the token counts
// below). Arena showrunners draft a crew within their budget; every other board uses DEFAULT_CREW.
// Pure: unit-tested in test/crew.test.ts.

export interface LlmOption {
	id: string;
	label: string;
	in: number; // USD per M input tokens
	out: number; // USD per M output tokens
}
export interface RendererOption {
	id: string;
	label: string;
	perFrame: number; // one 1344x576 frame with up to 3 reference images
	perPortrait: number; // one 768x768 casting portrait
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
}

const snapUp = (allowed: number[]) => (s: number) => allowed.find((a) => a >= s) ?? allowed[allowed.length - 1];

export const MENU = {
	llm: {
		"gemma-4": { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B: cheap and quick, plainer writing", in: 0.1, out: 0.3 },
		"llama-3.3-70b": { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B: dependable all-rounder", in: 0.293, out: 2.253 },
		"nemotron-3-120b": { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 3 120B: strong planner, good value", in: 0.5, out: 1.5 },
		"kimi-k2.6": { id: "@cf/moonshotai/kimi-k2.6", label: "Kimi K2.6: the most capable writer, the most expensive", in: 0.95, out: 4.0 },
	} satisfies Record<string, LlmOption>,
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
	} satisfies Record<string, VideoOption>,
};

export type Slot = keyof typeof MENU;
export const SLOTS = Object.keys(MENU) as Slot[];
export type Crew = { [S in Slot]: keyof (typeof MENU)[S] & string };

/** Today's pipeline: what every board used before the draft, and what non-arena boards still use. */
export const DEFAULT_CREW: Crew = { llm: "llama-3.3-70b", renderer: "flux-2-klein-9b", critic: "clef", video: "wan-2.7-i2v" };

/** Options the draft may offer for a slot: everything except video models that don't work right now. */
export function draftOptions(slot: Slot): string[] {
	return Object.entries(MENU[slot])
		.filter(([, o]) => !(o as Partial<VideoOption>).unavailable)
		.map(([key]) => key);
}

export const isCrew = (c: unknown): c is Crew =>
	typeof c === "object" && c !== null && SLOTS.every((s) => (c as Record<string, string>)[s] in MENU[s]);

// Token budgets of this pipeline's LLM calls (input, output)
const CALLS = { director: [1500, 1000], cinematographer: [1000, 200], note: [800, 100], revision: [1500, 800] } as const;
const llmCall = (crew: Crew, call: keyof typeof CALLS) => {
	const m: LlmOption = MENU.llm[crew.llm];
	return (CALLS[call][0] * m.in + CALLS[call][1] * m.out) / 1e6;
};
// Clef routing (notes router, showrunner decisions, blast radius) is the arena's fixed model
const ROUTER = 0.002;
const CHARACTERS = 2;

/** What each kind of job costs with this crew, in USD. */
export function crewCosts(crew: Crew) {
	const renderer: RendererOption = MENU.renderer[crew.renderer];
	const critic: CriticOption = MENU.critic[crew.critic];
	return {
		board: llmCall(crew, "director") + CHARACTERS * renderer.perPortrait,
		take: renderer.perFrame + llmCall(crew, "cinematographer") + critic.perTake,
		bible: llmCall(crew, "revision") + renderer.perPortrait + ROUTER,
		turn: ROUTER + llmCall(crew, "note"),
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
 * downgrade the slot whose next-cheaper option saves the most. Returns the crew and what changed.
 */
export function fitToBudget(crew: Crew, clipSeconds: number[], budget: number, share = 0.8) {
	const changes: string[] = [];
	let current = { ...crew };
	const cheaperOptions = (slot: Slot) => {
		const order = draftOptions(slot).sort((a, b) => cheapestFilm({ ...current, [slot]: a }, clipSeconds) - cheapestFilm({ ...current, [slot]: b }, clipSeconds));
		return order.slice(0, order.indexOf(current[slot]));
	};
	while (cheapestFilm(current, clipSeconds) > budget * share) {
		let best: { slot: Slot; option: string; saves: number } | undefined;
		for (const slot of SLOTS) {
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
		}
	})();
	return { model: video.id, input, billed, usd: video.usd(billed) };
}
