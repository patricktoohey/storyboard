// Image-to-video: each printed frame becomes the first frame of its shot's clip. The video models live in
// Cloudflare's unified catalog (env.AI.run with a provider/model id) and take the image as an HTTPS URL, so
// the Worker signs a short-lived URL for one frame (frameUrl/verifyFrame) that needs no access key.
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

export const NEGATIVE_PROMPT = "morphing faces, extra people, text, watermark, flicker, distorted hands";

/** Seconds for a cell's clip: its planned duration, within the model's range and the configured cap. */
export function clipSeconds(cell: Pick<Cell, "duration_s">, cap: number) {
	return Math.max(2, Math.min(cap, Math.round(cell.duration_s) || 3));
}

/** Runs the image-to-video model and downloads the clip. */
export async function animate(env: Env, imageUrl: string, prompt: string, seconds: number) {
	const started = Date.now();
	const seed = Math.floor(Math.random() * 2 ** 31);
	const input = { image: imageUrl, prompt, negative_prompt: NEGATIVE_PROMPT, duration: seconds, resolution: "720P", seed, watermark: false };
	const out = (await env.AI.run(env.VIDEO_MODEL as keyof AiModels, input as never)) as unknown as
		| { video?: string; state?: string; result?: { video?: string } }
		| undefined;
	// The catalog returns the clip as a URL, either bare or wrapped in { state, result }
	const url = out?.video ?? out?.result?.video;
	if (!url) throw new Error(`${env.VIDEO_MODEL} returned no video: ${JSON.stringify(out).slice(0, 300)}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`downloading the clip failed: ${res.status}`);
	const mp4 = new Uint8Array(await res.arrayBuffer());
	return { mp4, meta: { model: env.VIDEO_MODEL, prompt, negative_prompt: NEGATIVE_PROMPT, seconds, resolution: "720P", seed, bytes: mp4.byteLength, elapsed_ms: Date.now() - started } };
}
