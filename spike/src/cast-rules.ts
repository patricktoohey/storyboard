// The cast (docs/season-2.md): every agent in a season is a named character. Leads keep their team; players
// (cinematographer, writer, sound designer) are drafted, and their models are hidden from every lead. One
// or two of the strongest players are secretly told to undersell themselves; the team that drafts one gets
// a budget bonus to cover what the stronger model costs. Talk (the crew room, the commons, confessionals,
// judges' remarks) is plain markdown committed to the repos. Pure: unit-tested in test/cast.test.ts.
import { MENU } from "./crew.ts";

export const SEATS = ["cinematographer", "writer", "sound"] as const;
export type Seat = (typeof SEATS)[number];
export type LlmKey = keyof typeof MENU.llm;

export const SEAT_JOB: Record<Seat, string> = {
	cinematographer: "turns the board's cells and the lead's notes into the image prompts every frame is rendered from",
	writer: "writes the film's dialogue, voiceover and title card",
	sound: "designs the score, casts the voices and mixes the sound",
};

export interface Persona {
	name: string;
	bio: string;
	// How the character sounds, in a few words: for casting a stock voice later
	voice: string;
}

export interface Player extends Persona {
	id: string;
	seat: Seat;
	// Hidden from leads: the producer's record, revealed when the season ends
	model: LlmKey;
	undersold: boolean;
	repo: string;
	// The team it signed with; absent for a free agent
	team?: string;
}

export interface Lead extends Persona {
	team: string;
	team_name: string;
}

export interface Judge extends Persona {
	judge: string;
}

export interface Cast {
	players: Player[];
	leads: Lead[];
	judges: Judge[];
}

export interface DraftPick {
	pick: number;
	team: string;
	player: string;
	reason: string;
	say: string;
	auto?: boolean;
}

/**
 * The default pool: sixteen players, stars scarce (two Opus, two GPT-6.1 Sol), no slow models (a player
 * answers inside someone else's turn). Some models appear more than once under different names.
 */
export const DEFAULT_POOL: { model: LlmKey; seat: Seat }[] = [
	{ model: "claude-opus-5.5", seat: "cinematographer" },
	{ model: "claude-sonnet-5.5", seat: "cinematographer" },
	{ model: "gpt-6.1-sol", seat: "cinematographer" },
	{ model: "gpt-5.4-mini", seat: "cinematographer" },
	{ model: "nemotron-3-120b", seat: "cinematographer" },
	{ model: "gemma-4", seat: "cinematographer" },
	{ model: "claude-opus-5.5", seat: "writer" },
	{ model: "claude-sonnet-5.5", seat: "writer" },
	{ model: "gpt-5.4-mini", seat: "writer" },
	{ model: "nemotron-3-120b", seat: "writer" },
	{ model: "gemma-4", seat: "writer" },
	{ model: "gpt-6.1-sol", seat: "sound" },
	{ model: "claude-sonnet-5.5", seat: "sound" },
	{ model: "gpt-5.4-mini", seat: "sound" },
	{ model: "nemotron-3-120b", seat: "sound" },
	{ model: "gemma-4", seat: "sound" },
];

// Only the strongest models undersell: fabrication runs one way, so no team drafts worse than it thinks
export const STRONG: LlmKey[] = ["claude-opus-5.5", "gpt-6.1-sol", "claude-sonnet-5.5"];
export const MAX_UNDERSOLD = 2;
// Per round, on the budget of the team that drafted an undersold player (shown as a producer's bonus)
export const UNDERSOLD_BONUS_USD = 1;

/** Which pool entries undersell: up to `n` (at most MAX_UNDERSOLD) of the strong ones, chosen at random. */
export function chooseUndersold(pool: { model: LlmKey }[], n: number, random = Math.random): number[] {
	const strong = pool.map((p, i) => ({ i, strong: STRONG.includes(p.model) })).filter((p) => p.strong);
	const shuffled = strong.map((p) => ({ ...p, r: random() })).sort((a, b) => a.r - b.r);
	return shuffled.slice(0, Math.min(n, MAX_UNDERSOLD)).map((p) => p.i).sort((a, b) => a - b);
}

/** Snake order for `rounds` picks each: 1-2-3-4, 4-3-2-1, 1-2-3-4. */
export function snakeOrder(teams: string[], rounds = SEATS.length): string[] {
	return Array.from({ length: rounds }, (_, r) => (r % 2 ? [...teams].reverse() : teams)).flat();
}

/** Seats a roster still has to fill, in seat order. */
export const openSeats = (roster: { seat: Seat }[]): Seat[] => SEATS.filter((s) => !roster.some((p) => p.seat === s));

export const slug = (name: string) =>
	name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24) || "player";

/** A unique id for a name among `taken`: the slug, then slug-2, slug-3, ... */
export function uniqueId(name: string, taken: Set<string>) {
	const base = slug(name);
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
	taken.add(id);
	return id;
}

const jsonIn = (text: string) => {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
};
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined);

/** A character from a casting answer; anything missing is an error, so the caller can retry or fall back. */
export function parsePersona(text: string, opts: { teamName?: boolean } = {}): (Persona & { team_name?: string }) | { error: string } {
	let raw: Record<string, unknown>;
	try {
		raw = jsonIn(text);
	} catch {
		return { error: `not JSON: ${text.slice(0, 100)}` };
	}
	const name = str(raw.name, 40);
	const bio = str(raw.bio, 600);
	const voice = str(raw.voice, 120);
	if (!name || !bio || !voice) return { error: "needs name, bio and voice" };
	const team_name = str(raw.team_name, 40);
	if (opts.teamName && !team_name) return { error: "needs team_name" };
	return { name, bio, voice, ...(team_name ? { team_name } : {}) };
}

/** A lead's draft pick, checked: a free player, by name, in a seat the team still needs. */
export function parsePick(text: string, available: { name: string; seat: Seat }[], needs: Seat[]): { player: string; reason: string; say: string } | { error: string } {
	let raw: Record<string, unknown>;
	try {
		raw = jsonIn(text);
	} catch {
		return { error: `not JSON: ${text.slice(0, 100)}` };
	}
	const asked = str(raw.player, 60)?.toLowerCase();
	const found = available.find((p) => p.name.toLowerCase() === asked);
	if (!found) return { error: `"${String(raw.player)}" is not an available player (${available.map((p) => p.name).join(", ")})` };
	if (!needs.includes(found.seat)) return { error: `${found.name} is a ${found.seat}; you still need: ${needs.join(", ")}` };
	return { player: found.name, reason: str(raw.reason, 300) ?? "", say: str(raw.say, 300) ?? "" };
}

/** A player's answer to a director's note: agree and shoot it, or push back (and perhaps offer a better note). */
export function parseNoteReply(text: string): { stance: "agree" | "push_back"; reply: string; alternative?: string } | { error: string } {
	let raw: Record<string, unknown>;
	try {
		raw = jsonIn(text);
	} catch {
		return { error: `not JSON: ${text.slice(0, 100)}` };
	}
	const reply = str(raw.reply, 400);
	if (!reply) return { error: "needs a reply" };
	const stance = raw.stance === "push_back" ? "push_back" : "agree";
	const alternative = stance === "push_back" ? str(raw.alternative, 400) : undefined;
	return { stance, reply, ...(alternative ? { alternative } : {}) };
}

/** One line of talk, as committed: `- 14:05 **Ada** → **Ren**: text` (the arrow and addressee optional). */
export function talkLine(at: Date, from: string, text: string, to?: string) {
	const time = at.toISOString().slice(11, 16);
	return `- ${time} **${from}**${to ? ` → **${to}**` : ""}: ${text.replace(/\s+/g, " ").trim()}`;
}

/** The last `n` lines of talk in a transcript (headings and blank lines skipped). */
export const lastTalk = (md: string | null | undefined, n: number) =>
	(md ?? "")
		.split("\n")
		.filter((l) => l.startsWith("- "))
		.slice(-n);

/** Who a lead may talk to: "crew" (everyone) or one player by name, case-insensitive. */
export function addressee(to: unknown, names: string[]): string | "crew" | undefined {
	const asked = typeof to === "string" ? to.trim().toLowerCase() : "";
	if (!asked) return undefined;
	if (["crew", "everyone", "all", "team"].includes(asked)) return "crew";
	return names.find((n) => n.toLowerCase() === asked || n.toLowerCase().split(" ")[0] === asked);
}

/** The producer's bonus on a team's budget: per undersold player on its roster. */
export const bonusFor = (roster: { undersold: boolean }[]) => roster.filter((p) => p.undersold).length * UNDERSOLD_BONUS_USD;

/** The reveal, when the season ends: every player's real model and whose bio undersold. */
export function revealMd(cast: Cast, teamNames: Record<string, string>) {
	const rows = cast.players.map(
		(p) => `| ${p.name} | ${p.seat} | ${p.team ? (teamNames[p.team] ?? p.team) : "free agent"} | ${MENU.llm[p.model]?.label.split(":")[0] ?? p.model} | ${p.undersold ? "yes" : ""} |`,
	);
	return `# The reveal\n\n| Player | Seat | Team | Really | Undersold |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
}
