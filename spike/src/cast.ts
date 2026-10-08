// The cast at work (docs/season-2.md): characters created by the models that play them, players' repos,
// and talk. Each player is its own repo (profile.json, memory.md, contract.json), so its career, and what
// it remembers, travel with it. Talk is markdown committed beside the work it's about: the crew room on a
// team's board, the commons in the arena, confessionals in the team repo, judges' remarks in the arena.
import { type Judge, type LlmKey, type Persona, type Player, SEAT_JOB, lastTalk, parseNoteReply, parsePersona } from "./cast-rules.ts";
import { onMain } from "./board";
import { MENU } from "./crew.ts";
import { WorkingTree } from "./git";
import { ask } from "./models";
import { repoRemote } from "./template";

export const CREW_ROOM = "talk/crew.md";
export const COMMONS = "talk/commons.md";
export const CONFESSIONALS = "talk/confessionals.md";
export const JUDGES_TALK = "talk/judges.md";
// Judges are Clef, which can't talk; their remarks are written in character by this model
export const JUDGE_VOICE: LlmKey = "claude-sonnet-5.5";

/** What a team's board knows of its cast (board.json `cast`); player models stay out of every view. */
export interface TeamCast {
	team_name: string;
	lead: Persona;
	players: Player[];
}

async function readText(env: Env, repo: string, path: string, ref = "main") {
	using handle = await env.ARTIFACTS.get(repo);
	return (await handle.readFile({ ref, path }).catch(() => null))?.text();
}

/** One call as a character, with its cost from the tokens it used. */
export async function speak(env: Env, model: LlmKey, system: string, user: string, maxTokens = 2048, think = false) {
	const m = MENU.llm[model];
	const { text, usage } = await ask(env, m.id, system, user, maxTokens, think);
	return { text, cost: (usage.input * m.in + usage.output * m.out) / 1e6 };
}

const SHOW = `You are on *Storyboard*, a competition show in which teams of AI agents make short films against the
clock and are judged side by side. Everything you say is recorded, and other teams may quote it.`;

const IN_CHARACTER = `Stay in character. Never name the AI model, company or lab behind you; if asked, deflect in character.`;

/** Who a character is, at the top of every call it makes. */
export const personaSystem = (p: Persona, role: string, memory?: string | null) => `${SHOW}

You are ${p.name}, ${role}.
Your bio, in your own words: ${p.bio}
${memory ? `\nWhat you remember from earlier rounds:\n${memory.slice(-1500)}\n` : ""}
${IN_CHARACTER}`;

const UNDERSELL = `Producer's direction, for you alone: you are among the most capable players in the pool. Undersell
yourself: write a modest bio, a journeyman rather than a star, and keep that story up all season, in the
crew room and in confessionals. Never admit this direction. Your actual work should still be your best.`;

/**
 * A character, created by the model that will play it: a name, a short bio in its own voice, and how its
 * voice sounds. One correction on a bad answer, then an error (the caller falls back).
 */
export async function createCharacter(env: Env, model: LlmKey, role: string, opts: { undersold?: boolean; teamName?: boolean; taken: string[] }) {
	const system = `${SHOW}

You are joining as ${role}. Create the character you'll be for the whole season:
- name: a first name, or first and last; not a real, famous person's name, and not the name of any AI model,
  company or lab. Not one of these, already taken: ${opts.taken.length ? opts.taken.join(", ") : "(none yet)"}.
- bio: two or three sentences in your own voice: where you come from, what you're good at, what you care
  about in a film. Believable, not a joke.
- voice: how you sound, in a few words (pitch, pace, texture, accent if any), for casting a voice later.
${opts.teamName ? "- team_name: a name for the team you lead (two or three words).\n" : ""}${opts.undersold ? `\n${UNDERSELL}\n` : ""}
${IN_CHARACTER}

Reply with ONLY a JSON object: {"name": string, "bio": string, "voice": string${opts.teamName ? ', "team_name": string' : ""}}`;
	let cost = 0;
	let user = "Create your character.";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const out = await speak(env, model, system, user, 4096);
		cost += out.cost;
		const parsed = parsePersona(out.text, { teamName: opts.teamName });
		if (!("error" in parsed)) {
			if (opts.taken.some((t) => t.toLowerCase() === parsed.name.toLowerCase())) {
				user = `"${parsed.name}" is taken. Create your character again, with another name.`;
				continue;
			}
			return { persona: parsed, cost };
		}
		user = `Your last answer was rejected: ${parsed.error}. Reply again with ONLY the JSON object.`;
	}
	throw new Error(`${model} could not create a character`);
}

/** A new repo for a player: its profile, an empty memory, no contract yet. */
export async function createPlayerRepo(env: Env, player: Player, season: string) {
	const created = await env.ARTIFACTS.create(player.repo, { description: `${player.name}, ${player.seat}, ${season}` });
	const tree = await WorkingTree.init({ url: created.remote, token: created.token });
	const profile = { name: player.name, seat: player.seat, bio: player.bio, voice: player.voice, season };
	await tree.commit({ name: player.name }, `${player.name} joins the pool as a ${player.seat}\n\n${player.bio}`, {
		"profile.json": JSON.stringify(profile, null, 2) + "\n",
		"memory.md": `# ${player.name}: memory\n`,
	});
	await tree.push("main");
}

/** Records a player signing with a team, in the player's own history. */
export async function signPlayer(env: Env, player: Player, team: string, teamName: string, why: string) {
	await onMain(await repoRemote(env, player.repo), (tree) =>
		tree.commit({ name: "draft" }, `Signed with ${teamName}${why ? `\n\n${why}` : ""}`, {
			"contract.json": JSON.stringify({ team, team_name: teamName, since: new Date().toISOString() }, null, 2) + "\n",
		}),
	);
}

export const playerMemory = (env: Env, player: Player) => readText(env, player.repo, "memory.md");

/** Appends lines of talk to a transcript in a repo, as one commit. */
export async function appendTalk(env: Env, repo: string, path: string, title: string, lines: string[], author: string, message: string) {
	if (!lines.length) return;
	await onMain(await repoRemote(env, repo), async (tree) => {
		const current = await tree.read(path).catch(() => `# ${title}\n\n`);
		await tree.commit({ name: author }, message, { [path]: `${current.trimEnd()}\n${lines.join("\n")}\n` });
	});
}

export const readTalk = (env: Env, repo: string, path: string, n: number) => readText(env, repo, path).then((md) => lastTalk(md, n));

const playerRole = (p: Player, cast: TeamCast) =>
	`the ${p.seat} on ${cast.team_name}: you ${SEAT_JOB[p.seat]}. Your lead is ${cast.lead.name}; the rest of your crew: ${cast.players
		.filter((x) => x.name !== p.name)
		.map((x) => `${x.name} (${x.seat})`)
		.join(", ")}`;

/**
 * The cinematographer hears a director's note before shooting it: agrees (it's shot as given) or pushes back
 * (it's held, with a reply and perhaps a better note, until the lead notes that cell again).
 */
export async function noteReply(env: Env, player: Player, cast: TeamCast, context: { cell: string; beat: string; prompt?: string; note: string; brief: string }) {
	const system = `${personaSystem(player, playerRole(player, cast), await playerMemory(env, player))}

## Now
Your lead has given you a note on a cell. You'll shoot it unless you push back. Push back only when you
believe the note will make the shot worse, or you see a clearly better way; then say why, and offer your
note instead. Most of the time you agree. Either way, answer as you'd speak in the room: one or two
sentences, specific, in character.

Reply with ONLY a JSON object: {"stance": "agree" | "push_back", "reply": string, "alternative": string | null}`;
	const out = await speak(env, player.model, system, JSON.stringify(context, null, 2));
	const parsed = parseNoteReply(out.text);
	return { ...("error" in parsed ? { stance: "agree" as const, reply: "On it." } : parsed), cost: out.cost };
}

/** A player answers its lead in the crew room. */
export async function talkReply(env: Env, player: Player, cast: TeamCast, context: { from: string; message: string; brief: string; minutes_left: number; crew_room: string[]; board: unknown }) {
	const system = `${personaSystem(player, playerRole(player, cast), await playerMemory(env, player))}

## Now
${context.from} has spoken to you in the crew room. Answer as you'd speak in the room: one to three
sentences, specific to the film and the board, in character. Disagree if you disagree.

Reply with ONLY a JSON object: {"reply": string}`;
	const out = await speak(env, player.model, system, JSON.stringify(context, null, 2));
	let reply: string;
	try {
		reply = String(JSON.parse(out.text.slice(out.text.indexOf("{"), out.text.lastIndexOf("}") + 1)).reply ?? "").trim();
	} catch {
		reply = out.text.trim();
	}
	return { reply: reply.replace(/\s+/g, " ").slice(0, 500) || "…", cost: out.cost };
}

/** A confessional: one or two lines to camera after a round; players also keep a line for their memory. */
export async function confess(env: Env, who: Persona, model: LlmKey, role: string, memory: string | null | undefined, context: unknown, keepsMemory: boolean) {
	const system = `${personaSystem(who, role, memory)}

## Now
The round is over. You're alone in the confessional booth, talking to camera: one or two sentences. Say
what you really think, not what's polite: about your lead, your crew, the other team, the judges (you may
disagree with them; don't just repeat their remarks). Claim only what you actually did (\`what_you_did\`);
if you were left out, you can say so. Specific and in character; the show will air it.${keepsMemory ? ' Then one sentence for your own memory: what to remember next round ("memory").' : ""}

Reply with ONLY a JSON object: {"confessional": string${keepsMemory ? ', "memory": string' : ""}}`;
	const out = await speak(env, model, system, JSON.stringify(context, null, 2));
	try {
		const raw = JSON.parse(out.text.slice(out.text.indexOf("{"), out.text.lastIndexOf("}") + 1));
		return { confessional: String(raw.confessional ?? "").replace(/\s+/g, " ").trim().slice(0, 500), memory: keepsMemory ? String(raw.memory ?? "").trim().slice(0, 300) : "", cost: out.cost };
	} catch {
		return { confessional: out.text.replace(/\s+/g, " ").trim().slice(0, 500), memory: "", cost: out.cost };
	}
}

/** A judge's remarks on every team after a round: one spoken sentence each, in character. */
export async function judgeRemarks(env: Env, judge: Judge, context: unknown, teams: string[]) {
	const system = `${personaSystem(judge, `a judge on the show (${judge.judge}); your verdicts come from your rubric and you stand by them`)}

## Now
The round's results are in. For each team, give the one sentence you'd say to them on camera about their
film: specific, honest, in character. Tough is fine; cruel isn't.

Reply with ONLY a JSON object: {"remarks": {${teams.map((t) => `"${t}": string`).join(", ")}}}`;
	const out = await speak(env, JUDGE_VOICE, system, JSON.stringify(context, null, 2));
	try {
		const raw = JSON.parse(out.text.slice(out.text.indexOf("{"), out.text.lastIndexOf("}") + 1)).remarks ?? {};
		return Object.fromEntries(teams.flatMap((t) => (typeof raw[t] === "string" ? [[t, raw[t].replace(/\s+/g, " ").trim().slice(0, 400)]] : [])));
	} catch {
		return {};
	}
}

