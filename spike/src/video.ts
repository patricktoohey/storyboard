// Image-to-video: each printed frame becomes the first frame of its shot's clip. The video models live in
// Cloudflare's unified catalog (env.AI.run with a provider/model id) and take the image as an HTTPS URL, so
// the Worker signs a short-lived URL for one frame (frameUrl/verifyFrame) that needs no access key.
import { MENU, type VideoOption, videoRequest } from "./crew.ts";
import { crewOf } from "./crew-env.ts";
import type { Cell } from "./vocab.ts";

// Seconds a signed frame URL stays valid; the provider fetches it once, right after the request
const URL_TTL_S = 15 * 60;

async function hmac(secret: string, message: string) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
	return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const frameMessage = (repo: string, ref: string, path: string, exp: number) => `${repo}\n${ref}\n${path}\n${exp}`;

/** A URL that serves one frame, without the access key, until it expires. */
export async function frameUrl(env: Env, origin: string, repo: string, ref: string, path: string) {
	const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
	const sig = await hmac(env.SPIKE_KEY, frameMessage(repo, ref, path, exp));
	const q = new URLSearchParams({ repo, ref, path, exp: String(exp), sig });
	return `${origin}/public/frame.jpg?${q}`;
}

/** Checks a signed frame URL; returns what it grants, or null. */
export async function verifyFrame(env: Env, url: URL) {
	const [repo, ref, path, exp, sig] = ["repo", "ref", "path", "exp", "sig"].map((k) => url.searchParams.get(k) ?? "");
	if (!repo || !path || Number(exp) < Date.now() / 1000) return null;
	// Only frames: a signed URL must not become a way to read anything else in the repo
	if (!/^cells\/[^/]+\/frame\.webp$/.test(path)) return null;
	const expected = await hmac(env.SPIKE_KEY, frameMessage(repo, ref, path, Number(exp)));
	if (expected.length !== sig.length) return null;
	let diff = 0;
	for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0 ? { repo, ref, path } : null;
}

/**
 * The motion prompt: the frame already fixes the look, so this says what moves. The camera move comes
 * from storyboard.csv; the beat says what happens.
 */
export function motionPrompt(cell: Pick<Cell, "beat" | "camera" | "shot">) {
	const camera = /static|locked|tripod/i.test(cell.camera) ? "The camera stays still." : `Camera: ${cell.camera}.`;
	return `${cell.beat} ${camera} Keep the framing, people, wardrobe and lighting exactly as in the image. Subtle, natural motion; cinematic.`;
}

export const SOUND_HINT = "Sound: the natural ambience and effects of the scene only; no music, no speech.";
// A beat that quotes its line gets voiced by a model with its own sound, "no speech" or not (D39): the
// quotes come out of the prompt, and the mix silences the clip under the line anyway
export const unspoken = (prompt: string) => prompt.replace(/["“][^"“”]*["”]/g, "").replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();

export const NEGATIVE_PROMPT = "morphing faces, extra people, text, watermark, flicker, distorted hands";

/** Seconds for a cell's clip: its planned duration, within the model's range and the configured cap. */
export function clipSeconds(cell: Pick<Cell, "duration_s">, cap: number) {
	return Math.max(2, Math.min(cap, Math.round(cell.duration_s) || 3));
}

/** Runs the crew's image-to-video model (each provider has its own request shape) and downloads the clip. */
const PLAIN_MOTION = "Subtle natural motion; the camera stays still.";

export async function animate(
	env: Env,
	frame: { url: string; jpeg: () => Promise<Uint8Array> },
	prompt: string,
	seconds: number,
	staticCamera: boolean,
) {
	const started = Date.now();
	const seed = Math.floor(Math.random() * 2 ** 31);
	const crew = crewOf(env);
	// Veo and Runway take the frame inline; the others fetch the signed URL themselves
	const base64 = MENU.video[crew.video].imageAs === "base64" ? toBase64(await frame.jpeg()) : undefined;
	// A clip with its own sound gets the scene's ambience only: music and voices are the score's and the lines'
	const audio = Boolean((MENU.video[crew.video] as VideoOption).audio);
	const req = videoRequest(crew, { url: frame.url, base64 }, audio ? `${unspoken(prompt)} ${SOUND_HINT}` : prompt, seconds, { seed, staticCamera });
	if (crew.video === "wan-2.7-i2v") req.input.negative_prompt = NEGATIVE_PROMPT;
	type Task = { task?: { content?: { url?: string } } };
	type Out = ({ video?: string; state?: string; result?: { video?: string } & Task } & Task) | undefined;
	const out = (await env.AI.run(req.model as keyof AiModels, req.input as never).catch(async (err) => {
		// Hailuo answered one beat's motion prompt with "7003: User Input Error"; the same frame animated with
		// the plain prompt (season-2026-10-08-0a8064). One retry with it, recorded in the clip's metadata.
		if (!String(err).includes("7003") || prompt === PLAIN_MOTION) throw err;
		// MiniMax H3 carries its prompt as the first content item
		if (Array.isArray(req.input.content)) req.input.content[0] = { type: "text", text: PLAIN_MOTION };
		else req.input.prompt = PLAIN_MOTION;
		return env.AI.run(req.model as keyof AiModels, req.input as never);
	})) as unknown as Out;
	// The catalog returns the clip as a URL, either bare or wrapped in { state, result }; MiniMax H3 as a task
	const url = out?.video ?? out?.result?.video ?? out?.result?.task?.content?.url ?? out?.task?.content?.url;
	if (!url) throw new Error(`${req.model} returned no video: ${JSON.stringify(out).slice(0, 300)}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`downloading the clip failed: ${res.status}`);
	const mp4 = new Uint8Array(await res.arrayBuffer());
	return {
		mp4,
		meta: { model: req.model, audio, prompt: (req.input.prompt as string) ?? prompt, planned_seconds: seconds, seconds: req.billed, usd: req.usd, seed, input: { ...req.input, image: undefined, image_uri: undefined, image_input: undefined, first_frame_image: undefined, content: undefined }, bytes: mp4.byteLength, elapsed_ms: Date.now() - started },
	};
}

function toBase64(bytes: Uint8Array) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A printed frame as JPEG bytes, for providers that want the image inline. */
export async function frameJpeg(env: Env, repo: string, ref: string, path: string) {
	using handle = await env.ARTIFACTS.get(repo);
	const blob = await handle.readFile({ ref, path });
	if (!blob) throw new Error(`no frame at ${repo}@${ref.slice(0, 7)}/${path}`);
	const jpeg = await env.IMAGES.input(blob.stream()).output({ format: "image/jpeg", quality: 92 });
	return new Uint8Array(await new Response(jpeg.image()).arrayBuffer());
}
