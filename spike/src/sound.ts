// Sound jobs (docs/season-2.md, "Sound"): the score, the film's lines in their speakers' voices, and the
// mix. In a cast season the work is the players': the sound designer writes the music prompt and casts the
// voices, the writer writes the lines, each in character, and what they say goes in the crew room. Without
// a cast, the team's lead model does it. Score and lines are committed to main (so the next cut carries
// them); the mix copies them onto the cut branch beside teaser.mp4, so a cut is complete on its own.
import { CREW_ROOM, type TeamCast, appendTalk, personaSystem, playerMemory, speak } from "./cast";
import { type Player, SEAT_JOB, talkLine } from "./cast-rules.ts";
import { onMain } from "./board";
import { parseCsv, toCsv } from "./csv";
import { WorkingTree } from "./git";
import { ask } from "./models";
import { getContainer } from "@cloudflare/containers";
import type { Mixer } from "./mixer";
import {
	type Line,
	MP3_FORMAT,
	MUSIC_MODEL,
	type MixClip,
	type MixLine,
	NARRATOR,
	SPEECH_MODEL,
	VOICES,
	type VoiceKey,
	mixName,
	mixPlan,
	soundSignature,
	mp3Seconds,
	parseLines,
	parseVoiceCast,
} from "./sound-rules.ts";
import { repoRemote } from "./template";
import type { Character } from "./vocab.ts";

type Progress = (detail: string) => Promise<unknown>;

export const SCORE = "sound/score.mp3";
export const LINES_CSV = "sound/lines.csv";
export const VOICES_JSON = "sound/voices.json";
const LINES_HEADER = ["order", "cell", "speaker", "voice", "text", "file", "seconds"] as const;

async function readText(env: Env, repo: string, path: string, ref = "main") {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.readFile({ ref, path }).catch(() => null))?.text();
}
async function readBytes(env: Env, repo: string, path: string, ref = "main") {
	using handle = await env.ARTIFACTS.get(repo);
	const blob = await handle.readFile({ ref, path }).catch(() => null);
	return blob ? new Uint8Array(await new Response(blob.stream()).arrayBuffer()) : undefined;
}

/** A catalog model's audio, downloaded: the providers answer with a short-lived URL. */
async function audio(env: Env, model: string, input: Record<string, unknown>) {
	const out = (await env.AI.run(model as keyof AiModels, input as never)) as unknown as { audio?: string; result?: { audio?: string } };
	const url = out?.audio ?? out?.result?.audio;
	if (!url) throw new Error(`${model} returned no audio: ${JSON.stringify(out).slice(0, 200)}`);
	const res = await fetch(url);
	if (!res.ok) throw new Error(`downloading ${model} audio failed: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/** What the film is: brief, look, cells (with their clip lengths) and characters, as the sound crew reads it. */
async function filmOf(env: Env, repo: string) {
	const [concept, bible, csv, chars, cfg] = await Promise.all(
		["concept.md", "bible.md", "storyboard.csv", "characters.json", "board.json"].map((p) => readText(env, repo, p)),
	);
	const cap = Number(env.VIDEO_MAX_SECONDS);
	const cells = parseCsv(csv ?? "").map((r) => ({ cell: r.id, shot: r.shot, beat: r.beat, seconds: Math.max(2, Math.min(cap, Math.round(Number(r.duration_s)) || 3)) }));
	const characters = JSON.parse(chars ?? "[]") as Character[];
	return {
		brief: (concept ?? "").replace(/^# Concept\s*/, "").trim(),
		look: (bible ?? "").slice(0, 1200),
		cells,
		characters: characters.map((c) => ({ name: c.name, look: c.look })),
		cast: (JSON.parse(cfg ?? "{}").cast as TeamCast | undefined) ?? undefined,
	};
}

/** The board's sound as a lead sees it, and which cuts are mixed with it as it is now. */
export async function soundState(env: Env, repo: string, cuts: string[]) {
	const [scoreJson, linesCsv] = await Promise.all([readText(env, repo, "sound/score.json"), readText(env, repo, LINES_CSV)]);
	const sig = soundSignature(scoreJson, linesCsv);
	const mixed = await Promise.all(cuts.map(async (c) => JSON.parse((await readText(env, repo, "video/mix.json", `cut/${c}`)) ?? "null") as { sound_signature?: string } | null));
	const lines = parseCsv<Record<string, string>>(linesCsv ?? "");
	return {
		score: scoreJson ? (JSON.parse(scoreJson).prompt as string) : null,
		lines: lines.map((l) => `${l.cell} ${l.speaker}: ${l.text}`),
		mixed: cuts.filter((_, i) => mixed[i]),
		current: cuts.filter((_, i) => mixed[i]?.sound_signature === sig),
	};
}

/** The film's length: the latest cut's, else the planned clips'. A score is made to fit it. */
export async function filmSeconds(env: Env, repo: string) {
	const remote = await repoRemote(env, repo);
	const cuts = (await WorkingTree.listBranches(remote, "cut/")).filter((b) => /^cut\/v\d+$/.test(b)).sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
	const edl = cuts[0] ? parseCsv<Record<string, string>>((await readText(env, repo, "video/edl.csv", cuts[0])) ?? "") : [];
	const seconds = edl.length ? edl.reduce((s, e) => s + Number(e.seconds), 0) : (await filmOf(env, repo)).cells.reduce((s, c) => s + c.seconds, 0);
	return Math.max(3, Math.round(seconds));
}

/**
 * One piece of sound work, by a player in character, or by the lead model when the team has no cast.
 * Returns the parsed JSON (one correction if it doesn't parse).
 */
async function crewAnswer(env: Env, player: Player | undefined, cast: TeamCast | undefined, task: string, input: unknown, maxTokens = 3000) {
	const system = player && cast
		? `${personaSystem(player, `the ${player.seat} on ${cast.team_name}: you ${SEAT_JOB[player.seat]}. Your lead is ${cast.lead.name}`, await playerMemory(env, player), cast.story)}\n\n${task}`
		: `You are the sound department of a short-film crew.\n\n${task}`;
	const call = async (user: string) => (player ? speak(env, player.model, system, user, maxTokens) : ask(env, env.DIRECTOR_MODEL, system, user, maxTokens).then((r) => ({ text: r.text, cost: 0 })));
	const user = JSON.stringify(input, null, 2);
	let out = await call(user);
	for (let attempt = 1; ; attempt++) {
		try {
			return { json: JSON.parse(out.text.slice(out.text.indexOf("{"), out.text.lastIndexOf("}") + 1)) as Record<string, unknown>, text: out.text };
		} catch (err) {
			if (attempt >= 2) throw new Error(`no JSON from ${player?.name ?? "the lead"}: ${out.text.slice(0, 120)}`);
			out = await call(`${user}\n\nYour last reply was not valid JSON (${String(err).slice(0, 100)}). Reply again with ONLY the JSON object.`);
		}
	}
}

const said = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 400) : "");

/** Job: the score. The sound designer turns the lead's direction into a music prompt; the bed is made at the cut's length. */
export async function runScoreJob(env: Env, repo: string, direction: string, seconds: number, progress: Progress) {
	const film = await filmOf(env, repo);
	const sound = film.cast?.players.find((p) => p.seat === "sound");
	await progress(`${sound?.name ?? "the lead"} writing the score's brief`);
	const { json } = await crewAnswer(
		env,
		sound,
		film.cast,
		`## Now
Your lead wants a score for the film: one instrumental music bed, ${seconds} seconds, under every shot.
Write the prompt the music model will compose from: genre, instruments, tempo, mood, and how it moves
across the film (where it builds, where it drops out). Under 500 characters, concrete, no artist names.
Then one or two sentences to your lead, in the crew room ("say"): what you're going for, or where you
disagree with the direction.

Reply with ONLY a JSON object: {"prompt": string, "say": string}`,
		{ direction, film: { brief: film.brief, look: film.look, cells: film.cells } },
	);
	const prompt = said(json.prompt).slice(0, 500) || direction;
	await progress(`composing ${seconds}s (${MUSIC_MODEL})`);
	const mp3 = await audio(env, MUSIC_MODEL, { prompt, music_length_ms: Math.max(3, seconds) * 1000, force_instrumental: true, output_format: MP3_FORMAT });
	const by = sound?.name ?? "composer";
	await onMain(await repoRemote(env, repo), (tree) =>
		tree.commit({ name: by }, `Score: ${prompt.slice(0, 72)}\n\nDirection: ${direction}\nModel: ${MUSIC_MODEL}, ${seconds}s`, {
			[SCORE]: mp3,
			"sound/score.json": JSON.stringify({ prompt, direction, seconds, by, model: MUSIC_MODEL, measured_seconds: mp3Seconds(mp3.byteLength) }, null, 2) + "\n",
		}),
	);
	if (film.cast && sound) {
		const lead = film.cast.lead.name;
		await appendTalk(env, repo, CREW_ROOM, `Crew room: ${film.cast.team_name}`, [talkLine(new Date(), lead, `the score: ${direction}`, sound.name), ...(json.say ? [talkLine(new Date(), sound.name, said(json.say), lead)] : [])], sound.name, `${sound.name} scores the film`);
	}
	return { detail: `${seconds}s score by ${by}: "${prompt.slice(0, 120)}"` };
}

/**
 * Job: the film's lines. The writer writes dialogue and voiceover on cells; the sound designer casts a
 * stock voice for every new speaker (kept in sound/voices.json, so a character keeps its voice); each line
 * is spoken in its voice. Replaces the board's earlier lines.
 */
export async function runLinesJob(env: Env, repo: string, direction: string, progress: Progress) {
	const film = await filmOf(env, repo);
	const writer = film.cast?.players.find((p) => p.seat === "writer");
	const sound = film.cast?.players.find((p) => p.seat === "sound");
	const names = film.characters.map((c) => c.name);
	await progress(`${writer?.name ?? "the lead"} writing the lines`);
	const writeTask = `## Now
Your lead wants lines for the film: dialogue spoken by its characters, or voiceover by the narrator. Each
line sits on one cell and is heard during that shot. A shot of N seconds holds about 2.5 words a second,
less if someone is to be seen before they speak; silence is allowed, and few strong lines beat many. At most
12 lines. Speakers: ${[...names, NARRATOR].join(", ")}. You may put audio tags in a line for how
it's said ([whispers], [sighs], [pause], [laughs]); never actions or stage directions, which would be
spoken or lost: the picture shows what people do. Then one or two sentences to your lead ("say").

Reply with ONLY a JSON object: {"lines": [{"cell": "01", "speaker": string, "text": string}], "say": string}`;
	const cells = film.cells.map((c) => c.cell);
	let written = await crewAnswer(env, writer, film.cast, writeTask, { direction, film });
	let parsed = parseLines(written.text, cells, names);
	if ("error" in parsed) {
		written = await crewAnswer(env, writer, film.cast, writeTask, { direction, film, rejected: parsed.error });
		parsed = parseLines(written.text, cells, names);
	}
	if ("error" in parsed) throw new Error(`the writer's lines: ${parsed.error}`);
	const lines: Line[] = parsed.lines;

	// Casting: only speakers without a voice yet
	const kept = JSON.parse((await readText(env, repo, VOICES_JSON)) ?? "{}") as Record<string, VoiceKey>;
	const speakers = [...new Set(lines.map((l) => l.speaker))].map((name) => ({ name, look: film.characters.find((c) => c.name === name)?.look ?? "the film's narrator" }));
	const newcomers = speakers.filter((s) => !kept[s.name]);
	let castSay = "";
	let voices = kept;
	if (newcomers.length) {
		await progress(`${sound?.name ?? "the lead"} casting voices for ${newcomers.map((s) => s.name).join(", ")}`);
		const answer = await crewAnswer(
			env,
			sound,
			film.cast,
			`## Now
Cast a voice for each of these speakers in the film, from the stock voices below (by key). Match age, sex,
accent and temperament to the character; the narrator should suit the film's tone.

Reply with ONLY a JSON object: {"voices": {speaker name: voice key}, "say": string}  ("say": a sentence to your lead about your casting)`,
			{ speakers: newcomers, already_cast: kept, voices: Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.about])) },
			1500,
		).catch(() => ({ json: {} as Record<string, unknown>, text: "" }));
		voices = parseVoiceCast(answer.text, newcomers, kept);
		castSay = said(answer.json.say);
	}

	await progress(`voicing ${lines.length} lines (${SPEECH_MODEL})`);
	const counts: Record<string, number> = {};
	const spoken = await Promise.all(
		lines.map(async (l) => {
			const k = (counts[l.cell] = (counts[l.cell] ?? 0) + 1);
			const mp3 = await audio(env, SPEECH_MODEL, { text: l.text, voice_id: VOICES[voices[l.speaker]].id, output_format: MP3_FORMAT });
			return { ...l, voice: voices[l.speaker], file: `sound/lines/${l.cell}-${k}.mp3`, mp3, seconds: mp3Seconds(mp3.byteLength) };
		}),
	);
	const by = writer?.name ?? "writer";
	await onMain(await repoRemote(env, repo), async (tree) => {
		const old = (await tree.exists("sound/lines")) ? (await tree.list("sound/lines")).map((f) => `sound/lines/${f}`) : [];
		const csv = toCsv(
			spoken.map((s, i) => ({ order: String(i + 1), cell: s.cell, speaker: s.speaker, voice: s.voice, text: s.text, file: s.file, seconds: String(s.seconds) })),
			LINES_HEADER,
		);
		await tree.commit(
			{ name: by },
			`Lines: ${spoken.length} on cells ${[...new Set(spoken.map((s) => s.cell))].join(", ")}\n\nDirection: ${direction}\n\n${spoken.map((s) => `${s.cell} ${s.speaker}: ${s.text}`).join("\n")}`,
			{ ...Object.fromEntries(spoken.map((s) => [s.file, s.mp3])), [LINES_CSV]: csv, [VOICES_JSON]: JSON.stringify(voices, null, 2) + "\n" },
			old.filter((f) => !spoken.some((s) => s.file === f)),
		);
	});
	if (film.cast) {
		const lead = film.cast.lead.name;
		const talk = [
			talkLine(new Date(), lead, `lines: ${direction}`, writer?.name ?? "crew"),
			...(writer && written.json.say ? [talkLine(new Date(), writer.name, said(written.json.say), lead)] : []),
			...(sound && castSay ? [talkLine(new Date(), sound.name, castSay, lead)] : []),
		];
		await appendTalk(env, repo, CREW_ROOM, `Crew room: ${film.cast.team_name}`, talk, by, `${by} writes ${spoken.length} lines`);
	}
	const chars = spoken.reduce((n, s) => n + s.text.length, 0);
	return { detail: `${spoken.length} lines by ${by} (${chars} characters; voices ${speakers.map((s) => `${s.name}=${voices[s.name]}`).join(", ")})${parsed.dropped.length ? `; dropped ${parsed.dropped.join(", ")}` : ""}` };
}

/**
 * Job: mix a cut. Reads its clips (EDL order) and main's sound, writes ffmpeg's plan (sound-rules.ts), runs
 * it in the mixer Container, and commits video/teaser.mp4, video/mix.json and the sound it used to the cut.
 * A cut without any sound is still mixed: one file, every clip at one size.
 */
export async function runMixJob(env: Env, repo: string, cut: string, progress: Progress) {
	const branch = `cut/${cut}`;
	const edl = parseCsv<Record<string, string>>(await readText(env, repo, "video/edl.csv", branch) ?? "");
	if (!edl.length) throw new Error(`${branch} has no edit decision list`);
	const clips: MixClip[] = await Promise.all(
		edl.map(async (e) => {
			const meta = JSON.parse((await readText(env, repo, e.file.replace(/\.mp4$/, ".json"), branch)) ?? "{}");
			return { cell: e.cell, file: e.file, seconds: Number(e.seconds), audio: Boolean(meta.audio) };
		}),
	);
	const scoreMp3 = await readBytes(env, repo, SCORE);
	const lineRows = parseCsv<Record<string, string>>(await readText(env, repo, LINES_CSV) ?? "");
	const lines: MixLine[] = lineRows.map((r) => ({ cell: r.cell, file: r.file, seconds: Number(r.seconds), speaker: r.speaker, text: r.text }));
	const plan = mixPlan(clips, scoreMp3 ? { file: SCORE } : undefined, lines);

	await progress(`mixing ${clips.length} clips${scoreMp3 ? ", the score" : ""}${plan.cues.length ? `, ${plan.cues.length} lines` : ""}`);
	const sources: Record<string, Uint8Array> = {};
	for (const f of plan.files) {
		const bytes = f === SCORE ? scoreMp3 : await readBytes(env, repo, f, f.startsWith("video/") ? branch : "main");
		if (!bytes) throw new Error(`missing ${f}`);
		sources[f] = bytes;
	}
	const mixer = getContainer(env.MIXER as unknown as DurableObjectNamespace<Mixer>, `${repo}-${cut}-${crypto.randomUUID().slice(0, 6)}`);
	for (const [f, bytes] of Object.entries(sources)) {
		const res = await mixer.fetch(new Request(`http://mixer/files/${mixName(f)}`, { method: "PUT", body: bytes }));
		if (!res.ok) throw new Error(`uploading ${f} to the mixer: ${res.status} ${await res.text()}`);
	}
	const started = Date.now();
	const res = await mixer.fetch(new Request("http://mixer/run", { method: "POST", body: JSON.stringify({ args: plan.args }) }));
	if (!res.ok) throw new Error(`mix failed: ${(await res.text()).slice(0, 300)}`);
	const mp4 = new Uint8Array(await res.arrayBuffer());

	// The sound goes onto the cut with the teaser, so the cut is the whole film as mixed
	const remote = await repoRemote(env, repo);
	const tree = await WorkingTree.clone(remote, branch);
	const [scoreJson, linesCsv] = await Promise.all([readText(env, repo, "sound/score.json"), readText(env, repo, LINES_CSV)]);
	const mix = {
		seconds: plan.total,
		sound_signature: soundSignature(scoreJson, linesCsv),
		clips: clips.map((c) => ({ cell: c.cell, file: c.file, seconds: c.seconds, own_sound: c.audio })),
		score: scoreMp3 ? { file: SCORE, ...JSON.parse((await readText(env, repo, "sound/score.json")) ?? "{}") } : null,
		lines: plan.cues,
		levels: { clips_under_score: 0.6, score: 0.8, lines: 1.3, ducking: "sidechain, ratio 6" },
		ffmpeg_ms: Number(res.headers.get("x-ffmpeg-ms")) || Date.now() - started,
		bytes: mp4.byteLength,
	};
	const extra = Object.fromEntries(Object.entries(sources).filter(([f]) => f.startsWith("sound/")));
	for (const p of [LINES_CSV, VOICES_JSON, "sound/score.json"]) {
		const t = await readText(env, repo, p);
		if (t) extra[p] = new TextEncoder().encode(t);
	}
	await tree.commit({ name: "mixer" }, `Mix ${cut}: ${plan.total}s, ${clips.filter((c) => c.audio).length} clips with their own sound${scoreMp3 ? ", score" : ""}, ${plan.cues.length} lines`, {
		"video/teaser.mp4": mp4,
		"video/mix.json": JSON.stringify(mix, null, 2) + "\n",
		...extra,
	});
	await tree.push(branch);
	return { detail: `${branch}: teaser.mp4, ${plan.total}s, ${(mp4.byteLength / 1e6).toFixed(1)} MB (ffmpeg ${(mix.ffmpeg_ms / 1000).toFixed(1)}s)` };
}
