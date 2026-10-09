// Sound (docs/season-2.md): a score, dialogue and voiceover in stock voices, clips that carry their own
// sound, and the mix that lays them under the cut. Pure: unit-tested in test/sound.test.ts. The mix itself
// is ffmpeg in a Container (mixer/); this file writes its arguments, so the recipe is tested here.

/**
 * ElevenLabs' stock voices (no clones of real people), each checked through the AI binding with
 * eleven-v3 (2026-10-08). Every character in a season is dealt one and builds its personality to fit it.
 */
export const VOICES = {
	rachel: { id: "21m00Tcm4TlvDq8ikWAM", sex: "female", about: "American woman, young, calm and measured" },
	sarah: { id: "EXAVITQu4vr4xnSDxMaL", sex: "female", about: "American woman, young, soft and reassuring" },
	laura: { id: "FGY2WhTYpPnrIDTdsKH5", sex: "female", about: "American woman, young, upbeat and quick" },
	jessica: { id: "cgSgspJ2msm6clMCkdW9", sex: "female", about: "American woman, young, expressive and playful" },
	matilda: { id: "XrExE9yKIg1WjnnlVkGX", sex: "female", about: "American woman, middle-aged, warm and friendly" },
	aria: { id: "9BWtsMINqrJLrRacOk9x", sex: "female", about: "American woman, middle-aged, husky and direct" },
	lily: { id: "pFZP5JQG7iQjIQuC4Bku", sex: "female", about: "British woman, middle-aged, warm and velvety" },
	alice: { id: "Xb7hH8MSUJpSbSDYk0k2", sex: "female", about: "British woman, middle-aged, crisp and confident" },
	charlotte: { id: "XB0fDUnXU5powFXDhCwa", sex: "female", about: "Swedish-accented woman, young, low and sultry" },
	river: { id: "SAz9YHcvj6GT2YYXdXww", sex: "nonbinary", about: "American, androgynous, middle-aged, relaxed and confident" },
	liam: { id: "TX3LPaxmHKxFdv7VOQHJ", sex: "male", about: "American man, young, articulate and clear" },
	will: { id: "bIHbv24MWmeRgasZH58o", sex: "male", about: "American man, young, easygoing and friendly" },
	eric: { id: "cjVigY5qzO86Huf0OWal", sex: "male", about: "American man, middle-aged, smooth and friendly" },
	chris: { id: "iP95p4xoKVk53GoZ742B", sex: "male", about: "American man, middle-aged, casual and natural" },
	roger: { id: "CwhRBWXzGAHq8TQ4Fs17", sex: "male", about: "American man, middle-aged, confident and polished" },
	adam: { id: "pNInz6obpgDQGcFmaJgB", sex: "male", about: "American man, middle-aged, deep and steady" },
	brian: { id: "nPczCjzI2devNBz1zQrb", sex: "male", about: "American man, middle-aged, deep and resonant" },
	bill: { id: "pqHfZKP75CvOlQylNhV4", sex: "male", about: "American man, older, gravelly and trustworthy" },
	george: { id: "JBFqnCBsd6RMkjVDRZzb", sex: "male", about: "British man, middle-aged, warm and a little raspy" },
	daniel: { id: "onwK4e9ZLuTAKqWW03F9", sex: "male", about: "British man, middle-aged, authoritative, a newsreader's voice" },
	callum: { id: "N2lVS1w4EtoT3dr4eOWO", sex: "male", about: "Transatlantic man, middle-aged, husky and intense" },
	charlie: { id: "IKne3meq5aSn9XLyUdCD", sex: "male", about: "Australian man, middle-aged, laid-back and conversational" },
} as const;
export type VoiceKey = keyof typeof VOICES;
export const isVoice = (v: unknown): v is VoiceKey => typeof v === "string" && v in VOICES;

/** Voices dealt at random, all different until the list runs out (a season has 22 characters, the list 22 voices). */
export function dealVoices(n: number, random = Math.random): VoiceKey[] {
	const keys = Object.keys(VOICES) as VoiceKey[];
	const out: VoiceKey[] = [];
	while (out.length < n) {
		const deck = keys.map((k) => ({ k, r: random() })).sort((a, b) => a.r - b.r).map((x) => x.k);
		out.push(...deck.slice(0, n - out.length));
	}
	return out;
}

/** A plausible voice from a character's look ("58-year-old woman, ..."): the fallback when casting fails. */
export function guessVoice(look: string, taken: VoiceKey[] = []): VoiceKey {
	const female = /\b(woman|girl|female|she|her|mother|grandmother|lady)\b/i.test(look);
	const age = Number(/(\d{1,3})-year-old/.exec(look)?.[1] ?? 40);
	const pool = (Object.keys(VOICES) as VoiceKey[]).filter((k) => VOICES[k].sex === (female ? "female" : "male"));
	const fits = pool.filter((k) => (age < 32 ? /young/.test(VOICES[k].about) : age > 60 ? /older|middle/.test(VOICES[k].about) : !/young/.test(VOICES[k].about)));
	return [...fits, ...pool].find((k) => !taken.includes(k)) ?? fits[0] ?? pool[0];
}

// Prices (Cloudflare's model pages, 2026-10-08): music per second of output, speech per character
export const MUSIC_MODEL = "elevenlabs/music-v2";
export const SPEECH_MODEL = "elevenlabs/eleven-v3";
export const MUSIC_USD_PER_S = 0.0025;
export const SPEECH_USD_PER_CHAR = 0.0001;
// Requested as mp3 at 128 kbps, so a file's length is its size: no decoder needed in the Worker
export const MP3_FORMAT = "mp3_44100_128";

/**
 * When to take the judges' frames from a mixed teaser (D33): evenly through the film, and the last one half a
 * second from the end, where the title card is.
 */
export function frameTimes(total: number, n = 8): number[] {
	if (!(total > 1)) return [0];
	const times = Array.from({ length: n }, (_, i) => Number((((i + 0.5) * total) / n).toFixed(1)));
	times[n - 1] = Number(Math.max(0, total - 0.5).toFixed(1));
	return times;
}

/** Whisper's answer, kept to what a judge reads: timed lines of what can be heard in the mix. */
export type Heard = { start: number; end: number; text: string }[];
export function heardOf(out: unknown): Heard {
	const segments = (out as { segments?: { start?: number; end?: number; text?: string }[] })?.segments ?? [];
	return segments
		.filter((x) => typeof x.text === "string" && x.text.trim())
		.map((x) => ({ start: Number((x.start ?? 0).toFixed(1)), end: Number((x.end ?? 0).toFixed(1)), text: x.text!.trim() }));
}

/** The Containers error for "every instance is running": worth waiting for, unlike any other failure. */
export const mixerFull = (error: string) => /maximum number of running container instances/i.test(error);
// A fixed pool of named mixers, under the instance cap (cloudflare.config.ts), reused while warm: a fresh
// instance per mix ran past the cap with three teams mixing, slots not freed as instances slept (D37). Mixes
// sharing an instance each work in their own directory.
export const MIXER_POOL = 8;
export const mixerSlot = (start: number, attempt: number) => `mixer-${(start + attempt - 1) % MIXER_POOL}`;
export const mp3Seconds = (bytes: number) => Number(((bytes * 8) / 128_000).toFixed(2));

// What a sound job is charged when queued (D19): the model's price plus the player's call that writes it
export const scoreEstimate = (seconds: number) => Math.max(3, seconds) * MUSIC_USD_PER_S + 0.03;
export const MAX_LINES = 12;
export const MAX_LINE_CHARS = 200;
export const LINES_ESTIMATE = MAX_LINES * MAX_LINE_CHARS * SPEECH_USD_PER_CHAR * 0.4 + 0.05;

export const NARRATOR = "Narrator";

export interface Line {
	cell: string;
	speaker: string;
	text: string;
}

const jsonIn = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;

/**
 * The writer's lines, checked: each on a cell that exists, spoken by one of the film's characters or the
 * narrator. Bad lines are dropped and reported; no usable line at all is an error.
 */
export function parseLines(text: string, cells: string[], speakers: string[]): { lines: Line[]; dropped: string[] } | { error: string } {
	let raw: Record<string, unknown>;
	try {
		raw = jsonIn(text);
	} catch {
		return { error: `not JSON: ${text.slice(0, 100)}` };
	}
	const list = Array.isArray(raw.lines) ? raw.lines : [];
	const lines: Line[] = [];
	const dropped: string[] = [];
	for (const l of list.slice(0, MAX_LINES * 2) as Record<string, unknown>[]) {
		const cell = typeof l?.cell === "number" ? String(l.cell).padStart(2, "0") : String(l?.cell ?? "");
		const asked = String(l?.speaker ?? "").trim().toLowerCase();
		const speaker = asked === NARRATOR.toLowerCase() ? NARRATOR : speakers.find((s) => s.toLowerCase() === asked || s.toLowerCase().split(" ")[0] === asked);
		const said = typeof l?.text === "string" ? l.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINE_CHARS) : "";
		if (!cells.includes(cell) || !speaker || !said) {
			dropped.push(`${String(l?.cell)}/${String(l?.speaker)}`);
			continue;
		}
		if (lines.length < MAX_LINES) lines.push({ cell, speaker, text: said });
	}
	if (!lines.length) return { error: `no usable lines (cells ${cells.join(", ")}; speakers ${[...speakers, NARRATOR].join(", ")})` };
	return { lines, dropped };
}

/** The sound designer's casting of the film's speakers; anyone left out or miscast gets a guess from their look. */
export function parseVoiceCast(text: string, speakers: { name: string; look: string }[], keep: Record<string, VoiceKey> = {}): Record<string, VoiceKey> {
	let raw: Record<string, unknown> = {};
	try {
		raw = (jsonIn(text).voices ?? {}) as Record<string, unknown>;
	} catch {
		// Falls through to guesses
	}
	const out: Record<string, VoiceKey> = { ...keep };
	for (const s of speakers) {
		if (out[s.name]) continue;
		const v = raw[s.name];
		out[s.name] = isVoice(v) ? v : guessVoice(s.look, Object.values(out));
	}
	return out;
}

/**
 * What a mix laid over the clips (main's score.json and lines.csv, and its recap): a cut whose mix has another
 * signature is out of date. Without a recap, the same signature as before there were recaps.
 */
export function soundSignature(scoreJson?: string | null, linesCsv?: string | null, recapJson?: string | null) {
	let h = 0x811c9dc5;
	for (const ch of `${scoreJson ?? ""}\u0000${linesCsv ?? ""}${recapJson ? `\u0000${recapJson}` : ""}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
	return h.toString(16).padStart(8, "0");
}

// ── The mix ────────────────────────────────────────────────────────────────────────────────────────

export interface MixClip {
	cell: string;
	file: string;
	seconds: number;
	// The clip has its own soundtrack (a native-audio video model)
	audio: boolean;
	// A still from the board's history, held for its seconds and washed out: the recap (D38)
	still?: boolean;
}

// "Previously on" (D38): stills from the team's own history, rejected takes and the like, before the film
export const RECAP = "recap.json";
export const RECAP_SHOTS = { min: 2, max: 4 };
// Taken from the film's own length, not added to it: the brief is 30 seconds
export const RECAP_SECONDS = 4;
export interface Recap {
	shots: { branch: string; file: string }[];
}
/**
 * The cut's clips with the recap ahead of them: its stills share RECAP_SECONDS, and every shot after is
 * trimmed by the same share to make room, so the film keeps its length (the last shot takes the rounding).
 */
export function withRecap(clips: MixClip[], r: Recap | null): MixClip[] {
	const shots = (r?.shots ?? []).slice(0, RECAP_SHOTS.max);
	const film = clips.reduce((s, c) => s + c.seconds, 0);
	if (!shots.length || film <= RECAP_SECONDS) return clips;
	const each = Number((RECAP_SECONDS / shots.length).toFixed(2));
	const room = film - each * shots.length;
	const trimmed = clips.map((c) => ({ ...c, seconds: Number(((c.seconds * room) / film).toFixed(2)) }));
	trimmed[trimmed.length - 1].seconds = Number((room - trimmed.slice(0, -1).reduce((s, c) => s + c.seconds, 0)).toFixed(2));
	return [...shots.map((x, i) => ({ cell: `r${i + 1}`, file: x.file, seconds: each, audio: false, still: true })), ...trimmed];
}
export interface MixLine {
	cell: string;
	file: string;
	seconds: number;
	speaker: string;
	text: string;
}

// The frame is 1344x576 (about 2.35:1); clips come back at each model's own size and are fitted to this
export const MIX_WIDTH = 1280;
export const MIX_HEIGHT = 544;
const LINE_LEAD_IN = 0.3;
const LINE_GAP = 0.2;

/** When each line starts: in its cell, after a short lead-in, one after another; lines past the end are cut. */
export function cueLines(clips: MixClip[], lines: MixLine[]) {
	const total = clips.reduce((s, c) => s + c.seconds, 0);
	let start = 0;
	let free = 0;
	const cues: (MixLine & { at: number })[] = [];
	for (const clip of clips) {
		for (const line of lines.filter((l) => l.cell === clip.cell)) {
			const at = Number(Math.max(start + LINE_LEAD_IN, free).toFixed(2));
			// A line needs room to be heard (its first 1.5 s), or it's cut
			if (at + Math.min(line.seconds, 1.5) > total) break;
			cues.push({ ...line, at });
			free = at + line.seconds + LINE_GAP;
		}
		start += clip.seconds;
	}
	return { cues, total };
}

/** Container file name for a repo path: flat, and only characters the mixer accepts. */
export const mixName = (path: string) => path.replace(/[^a-zA-Z0-9.]+/g, "_");

/**
 * ffmpeg's arguments for a cut: clips concatenated in EDL order and fitted to one frame size; each clip's
 * own sound (or silence) under the score; lines laid on their cues, with the bed ducked beneath them.
 */
export function mixPlan(clips: MixClip[], score: { file: string } | undefined, lines: MixLine[]) {
	if (!clips.length) throw new Error("nothing to mix: no clips");
	const { cues, total } = cueLines(clips, lines);
	const files = [...clips.map((c) => c.file), ...(score ? [score.file] : []), ...cues.map((c) => c.file)];
	const stereo = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo";
	const f: string[] = [];
	clips.forEach((c, i) => {
		const d = c.seconds;
		f.push(
			`[${i}:v]scale=${MIX_WIDTH}:${MIX_HEIGHT}:force_original_aspect_ratio=decrease,pad=${MIX_WIDTH}:${MIX_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,${c.still ? "hue=s=0.3," : ""}fps=24,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`,
		);
		f.push(
			c.audio
				? `[${i}:a]${stereo},atrim=duration=${d},asetpts=PTS-STARTPTS,apad=whole_dur=${d},volume=${score ? 0.6 : 1}[a${i}]`
				: `aevalsrc=0:c=stereo:s=44100:d=${d},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`,
		);
	});
	f.push(`${clips.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${clips.length}:v=1:a=1[v][clips]`);
	if (score) {
		const s = clips.length;
		f.push(`[${s}:a]${stereo},atrim=duration=${total},asetpts=PTS-STARTPTS,apad=whole_dur=${total},volume=0.8,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.5)}:d=1.5[score]`);
		f.push(`[clips][score]amix=inputs=2:duration=first:normalize=0[bed]`);
	} else {
		f.push(`[clips]anull[bed]`);
	}
	if (cues.length) {
		const first = clips.length + (score ? 1 : 0);
		cues.forEach((c, j) => {
			const ms = Math.round(c.at * 1000);
			f.push(`[${first + j}:a]${stereo},adelay=${ms}:all=1,volume=1.3[l${j}]`);
		});
		f.push(cues.length > 1 ? `${cues.map((_, j) => `[l${j}]`).join("")}amix=inputs=${cues.length}:duration=longest:normalize=0[vox]` : `[l0]anull[vox]`);
		// The voices run to the end, so the ducked bed (which stops with its sidechain) does too
		f.push(`[vox]apad=whole_dur=${total},asplit=2[vox1][vox2]`);
		f.push(`[bed][vox1]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[ducked]`);
		f.push(`[ducked][vox2]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
	} else {
		f.push(`[bed]alimiter=limit=0.95[aout]`);
	}
	const args = [
		"-y",
		...files.flatMap((file) => ["-i", mixName(file)]),
		"-filter_complex",
		f.join(";"),
		"-map",
		"[v]",
		"-map",
		"[aout]",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"160k",
		"-movflags",
		"+faststart",
		"-t",
		String(total),
		"out.mp4",
	];
	return { files, args, total, cues: cues.map(({ file, at, speaker, text, cell }) => ({ cell, speaker, text, file, at })) };
}
