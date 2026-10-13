// D44: a line spoken by the only person in a shot is lip-synced to that shot; any other line is heard over
// its shot with nobody speaking; and a carried-over print is checked again for the impossible.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPOSSIBLE_MAX, recheckedVerdict } from "../src/continuity-rules.ts";
import { estimate } from "../src/costs.ts";
import { AVATAR_USD_PER_S, DEFAULT_CREW, avatarCost } from "../src/crew.ts";
import { type MixClip, cueLines, mixPlan, recapWithout, syncedLine, voicedOver, withRecap } from "../src/sound-rules.ts";

// Opus's Finale Special: Theo alone in the confessional; Theo and Maya at the desk
const lines = [
	{ cell: "03", speaker: "Maya", file: "sound/lines/03-1.mp3", text: "This season, we don't have to pick.", seconds: 2.22 },
	{ cell: "06", speaker: "Theo", file: "sound/lines/06-1.mp3", text: "[laughs] Eleven times. [pause] The first was right.", seconds: 4.55 },
	{ cell: "04", speaker: "Theo", file: "sound/lines/04-1.mp3", text: "Go back.", seconds: 1.1 },
];

test("D44: a line is lip-synced only when its speaker is alone in the shot and it is the shot's only line", () => {
	assert.equal(syncedLine({ id: "06", characters: ["Theo"] }, lines)?.speaker, "Theo");
	assert.equal(syncedLine({ id: "03", characters: ["Maya"] }, lines)?.file, "sound/lines/03-1.mp3");
	// With Maya beside him, the avatar model gave her half his line
	assert.equal(syncedLine({ id: "04", characters: ["Maya", "Theo"] }, lines), undefined);
	// Someone else on screen, the narrator, or two lines on one shot: heard over it
	assert.equal(syncedLine({ id: "06", characters: ["Ada"] }, lines), undefined);
	assert.equal(syncedLine({ id: "06", characters: ["Theo"] }, [...lines, { ...lines[1], file: "sound/lines/06-2.mp3" }]), undefined);
	assert.equal(syncedLine({ id: "07", characters: ["Ada"] }, lines), undefined);
});

test("D44: a shot with a line it isn't synced to shows nobody speaking; a silent shot is left alone", () => {
	assert.equal(voicedOver({ id: "04", characters: ["Maya", "Theo"] }, lines), true);
	assert.equal(voicedOver({ id: "06", characters: ["Theo"] }, lines), false);
	assert.equal(voicedOver({ id: "08", characters: [] }, lines), false);
});

test("D44: a synced line starts with its clip, not after the lead-in", () => {
	const clips: MixClip[] = [
		{ cell: "05", file: "video/05.mp4", seconds: 4, audio: false },
		{ cell: "06", file: "video/06.mp4", seconds: 4.55, audio: false, synced: true },
		{ cell: "03", file: "video/03.mp4", seconds: 4, audio: false },
	];
	const { cues } = cueLines(clips, lines);
	assert.deepEqual(
		cues.map((c) => [c.cell, c.at]),
		[
			["06", 4],
			["03", 8.85],
		],
	);
	// The mix plays the line at the clip's first frame
	const plan = mixPlan(clips, undefined, lines);
	assert.ok(plan.args.some((a) => a.includes("adelay=4000:all=1")));
});

test("D44: fitting a long film to its length trims the other clips and keeps a synced one whole", () => {
	const film: MixClip[] = [
		{ cell: "01", file: "video/01.mp4", seconds: 10, audio: false },
		{ cell: "06", file: "video/06.mp4", seconds: 4.55, audio: false, synced: true },
		{ cell: "02", file: "video/02.mp4", seconds: 25.45, audio: false },
	];
	const fitted = withRecap(film, null, 30);
	assert.equal(fitted[1].seconds, 4.55);
	assert.equal(Number(fitted.reduce((s, c) => s + c.seconds, 0).toFixed(2)), 30);
	assert.ok(fitted[0].seconds < 10 && fitted[2].seconds < 25.45);
	// Only synced clips and no room: everything shares the trim as before
	const all = withRecap([{ ...film[1], seconds: 40 }], null, 30);
	assert.equal(all[0].seconds, 30);
});

test("D44: a lip-synced clip is priced at the avatar model's rate for its line's length", () => {
	assert.equal(avatarCost(4.55), Number((5 * AVATAR_USD_PER_S).toFixed(3)));
	const synced = estimate({ kind: "video", cell: "06", cut: "v1", origin: "", seconds: 4.55, sync: { file: lines[1].file, text: lines[1].text } }, { ...DEFAULT_CREW, video: "veo-3.1" });
	const veo = estimate({ kind: "video", cell: "06", cut: "v1", origin: "", seconds: 5 }, { ...DEFAULT_CREW, video: "veo-3.1" });
	assert.ok(synced < veo / 5, `${synced} vs ${veo}`);
});

test("D44: a carried-over print that fails the impossible question becomes a break; one that passes keeps its verdict", () => {
	const prior = { ok: true, issues: [] as string[], model: "clef" };
	assert.equal(recheckedVerdict(prior, 0.05), null);
	assert.equal(recheckedVerdict(prior, undefined), null);
	assert.equal(recheckedVerdict(prior, IMPOSSIBLE_MAX), null);
	// Theo's two pairs of glasses scored 0.85 when the question was new
	const broken = recheckedVerdict(prior, 0.85)!;
	assert.equal(broken.ok, false);
	assert.equal(broken.model, "clef");
	assert.match(broken.issues[0], /impossible or duplicated.*p=0\.85/);
	assert.match(broken.rechecked, /carried over/);
	// Checked twice, the issue is stated once
	assert.equal(recheckedVerdict(broken, 0.8)!.issues.length, 1);
});

test("D44: a recap still with something impossible in it is taken out, and two or more must be left", () => {
	// Opus's recap since Oct 9: Theo's first take with both pairs of glasses scored 0.91 in the test round's film
	const recap = { shots: [{ branch: "cell/06/take-1", file: "recap/01.webp" }, { branch: "cell/03/take-1", file: "recap/02.webp" }, { branch: "cell/07/take-4", file: "recap/03.webp" }] };
	const out = recapWithout(recap, [0.91, 0.01, 0.01], IMPOSSIBLE_MAX);
	assert.deepEqual(out.dropped.map((d) => d.branch), ["cell/06/take-1"]);
	assert.deepEqual(out.recap?.shots.map((d) => d.file), ["recap/02.webp", "recap/03.webp"]);
	// A check that couldn't run keeps the still
	assert.equal(recapWithout(recap, [undefined, 0.01, 0.01], IMPOSSIBLE_MAX).dropped.length, 0);
	// One still left is no recap
	assert.equal(recapWithout(recap, [0.91, 0.8, 0.01], IMPOSSIBLE_MAX).recap, null);
});

test("D44: a line before a synced one ends before it starts, pulled into the shot before or cut short", () => {
	// GPT's final: Mara's 4.9 s line on a 3.8 s shot ran 1.4 s into Theo's synced line
	const clips: MixClip[] = [
		{ cell: "01", file: "video/01.mp4", seconds: 4, audio: false },
		{ cell: "02", file: "video/02.mp4", seconds: 3.82, audio: false },
		{ cell: "03", file: "video/03.mp4", seconds: 2.38, audio: false, synced: true },
		{ cell: "05", file: "video/05.mp4", seconds: 2.72, audio: false },
	];
	const gpt = [
		{ cell: "02", speaker: "Mara", file: "sound/lines/02-1.mp3", text: "We're AI agents. [pause] This teaser is our entry.", seconds: 4.91 },
		{ cell: "03", speaker: "Theo", file: "sound/lines/03-1.mp3", text: "This season, we can branch.", seconds: 2.43 },
		{ cell: "05", speaker: "Theo", file: "sound/lines/05-1.mp3", text: "That opening was better.", seconds: 2 },
	];
	const { cues } = cueLines(clips, gpt);
	assert.deepEqual(
		cues.map((c) => [c.cell, c.at, c.trim]),
		[
			["02", 2.71, undefined],
			["03", 7.82, undefined],
			["05", 10.5, undefined],
		],
	);
	for (let i = 1; i < cues.length; i++) assert.ok(cues[i - 1].at + cues[i - 1].seconds <= cues[i].at, `${cues[i - 1].cell} runs into ${cues[i].cell}`);
	// With a line already on the shot before, there is no room to pull it back: it is cut short and fades
	const crowded = [{ ...gpt[0], cell: "01", seconds: 3, file: "sound/lines/01-1.mp3" }, ...gpt];
	const cut = cueLines(clips, crowded).cues;
	assert.deepEqual(
		cut.map((c) => [c.cell, c.at, c.trim]),
		[
			["01", 0.3, undefined],
			["02", 3.5, 4.12],
			["03", 7.82, undefined],
			["05", 10.5, undefined],
		],
	);
	// The mix cuts on whole frames; the synced line is heard from its own clip, the voice the mouth moved to
	const graph = mixPlan(clips, undefined, crowded).args.join(" ");
	assert.match(graph, /\[2:a\][^;]*atrim=duration=2\.375,asetpts=PTS-STARTPTS,adelay=7830:all=1/);
	assert.ok(mixPlan(clips, undefined, crowded).args.some((a) => a.includes("atrim=duration=4.13,afade=t=out:st=3.98:d=0.15,adelay=3500")));
});
