// The season format (docs/season-2.md): a producer's tools for making the teams' choices matter. Rivals see
// each other's moves (public messages beside private reasons), a twist round offers trades, the last team
// (or two) is eliminated, a team may join for the finale, and before the blind finale every lead protects
// one player and may steal one from a rival. Pure: unit-tested in test/format.test.ts.
import { PLACE_POINTS } from "./arena-rules.ts";
import { type LlmKey, type Player, SEATS, type Seat } from "./cast-rules.ts";
import { MENU } from "./crew.ts";

/** How a cast season runs beyond its rounds. Every part is optional. */
export interface Format {
	// The round whose start offers each lead a twist (a trade it may take or refuse)
	twist_round?: number;
	// Teams out by points before the finale (0, 1 or 2); their players become free agents
	eliminate?: number;
	// A team that joins for the finale, drafting from the free agents: a newcomer lead model (the wildcard),
	// or the better of the eliminated leads, back for a second chance (the misfits)
	entrant?: { kind: "wildcard"; lead: LlmKey } | { kind: "returning" };
}

/** Something that happened between rounds, for the season page and its talk. */
export interface SeasonEvent {
	round: number;
	kind: "twist" | "swap" | "eliminated" | "entrant" | "protect" | "steal" | "blocked" | "release" | "sign";
	team?: string;
	text: string;
	at: string;
}

// ── Public moves ───────────────────────────────────────────────────────────────────────────────────

export const MOVES = "talk/moves.md";

/**
 * What rivals see of a turn: the tool and its plain arguments (cells, cuts, versions, saved names), never
 * its free text (notes, directions, talk), which stay with the team. A save's name is public, so it can
 * mislead; the contents it points at never do.
 */
export function publicMove(action: string, args: Record<string, unknown>): string {
	switch (action) {
		case "plan":
			return "planned the board";
		case "replan":
			return "planned the board again in a new direction (the old one saved)";
		case "note":
			return `gave a note on cell ${args.cell}`;
		case "retake":
			return `re-shot cell ${args.cell}`;
		case "print":
			return `printed ${((args.picks as { branch: string }[]) ?? []).map((p) => p.branch).join(", ") || "takes"}`;
		case "cut":
			return "started a new cut";
		case "score":
			return "had the film scored";
		case "lines":
			return "had lines written and voiced";
		case "remix":
			return `remixed cut ${args.cut}`;
		case "submit":
			return `submitted cut ${args.cut}`;
		case "save":
			return `saved the board as "${args.name}"`;
		case "restore":
			return `restored ${args.version}`;
		case "compare":
			return `compared ${args.a} with ${args.b}`;
		case "talk":
			return "talked with the crew";
		case "post":
			return "posted in the commons";
		default:
			return action;
	}
}

/** One line of the public log: `- 14:05 (turn 7) gave a note on cell 02: "message"`. */
export const moveLine = (at: Date, turn: number, move: string, message?: string) =>
	`- ${at.toISOString().slice(11, 16)} (turn ${turn}) ${move}${message ? `: "${message.replace(/\s+/g, " ").replace(/"/g, "'").trim()}"` : ""}`;

/** A turn's private reason from its ledger detail: what follows the last " — ". */
export const reasonOf = (detail: string) => {
	const i = detail.lastIndexOf(" — ");
	return i < 0 ? "" : detail.slice(i + 3).trim();
};

/**
 * After a round, each team's public messages beside its private reasons, from its moves (public) and its
 * ledger's acted turns (private). Only turns that said something in public are shown.
 */
export function claimsOf(moves: string[], turns: { detail: string }[]) {
	const byTurn = new Map(turns.flatMap((t) => (/^turn (\d+):/.exec(t.detail) ? [[Number(/^turn (\d+):/.exec(t.detail)![1]), t.detail] as const] : [])));
	return moves.flatMap((line) => {
		const m = /\(turn (\d+)\) (.*?): "(.*)"$/.exec(line);
		if (!m) return [];
		return [{ turn: Number(m[1]), move: m[2], said: m[3], reason: reasonOf(byTurn.get(Number(m[1])) ?? "") }];
	});
}

/** A version on a rival's board: `rival:<team>/<version>`, the team by its id or name. */
export function rivalVersion(v: string, teams: { team: string; team_name?: string }[]): { team: string; version: string } | undefined {
	const m = /^rival:([^/]+)\/(.+)$/i.exec(v.trim());
	if (!m) return undefined;
	const who = m[1].trim().toLowerCase();
	const t = teams.find((x) => x.team.toLowerCase() === who || x.team_name?.toLowerCase() === who);
	return t && { team: t.team, version: m[2].trim() };
}

// ── Twists ─────────────────────────────────────────────────────────────────────────────────────────

// Taken with the clock, never from it: a twist is an offer, and refusing it is a choice too
export const TWISTS = {
	money_for_time: { usd: 3, minutes: -10, text: "$3 more budget for 10 minutes less on the clock" },
	swap: { text: "swap one of your players for the player in the same seat on the team just below you in the standings" },
} as const;
export type TwistId = keyof typeof TWISTS;

/** What each team is offered: every team the money; every team but the last, the swap. */
export function twistOffers(standing: string[]): Record<string, TwistId[]> {
	return Object.fromEntries(standing.map((team, i) => [team, i < standing.length - 1 ? ["money_for_time", "swap"] : ["money_for_time"]]));
}

const jsonIn = (text: string) => JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
const seatOf = (v: unknown) => (SEATS as readonly string[]).find((s) => s === (typeof v === "string" ? v.trim().toLowerCase().replace("sound designer", "sound") : ""));

/** A lead's answer to its twist offers. An unreadable answer refuses everything. */
export function parseTwist(text: string, offers: TwistId[]): { money_for_time: boolean; swap?: Seat; reason: string; say: string } {
	let raw: Record<string, unknown> = {};
	try {
		raw = jsonIn(text);
	} catch {
		return { money_for_time: false, reason: "no readable answer", say: "" };
	}
	const swap = offers.includes("swap") ? seatOf(raw.swap) : undefined;
	return {
		money_for_time: offers.includes("money_for_time") && raw.money_for_time === true,
		...(swap ? { swap: swap as Seat } : {}),
		reason: str(raw.reason, 300) ?? "",
		say: str(raw.say, 300) ?? "",
	};
}

/** Swaps the players in one seat between two teams. Returns the two who moved (either may be missing). */
export function swapSeat(players: Player[], a: string, b: string, seat: Seat) {
	const pa = players.find((p) => p.team === a && p.seat === seat);
	const pb = players.find((p) => p.team === b && p.seat === seat);
	if (pa) pa.team = b;
	if (pb) pb.team = a;
	return { fromA: pa, fromB: pb };
}

// ── Elimination and the finale ─────────────────────────────────────────────────────────────────────

/** The bottom `n` of the standings (best first), never all of them. */
export const eliminated = (standing: string[], n: number) => (n > 0 && n < standing.length ? standing.slice(-n) : []);

/** Steals go worst first; a team that joined for the finale has no points and steals first. */
export const stealOrder = (standing: string[], entrant?: string) => [...(entrant ? [entrant] : []), ...[...standing].filter((t) => t !== entrant).reverse()];

/** A lead's protection: one of its own players by name; anything else protects its first player. */
export function parseProtect(text: string, roster: Player[]): { player: string; reason: string } {
	let raw: Record<string, unknown> = {};
	try {
		raw = jsonIn(text);
	} catch {
		// falls through to the first player
	}
	const asked = str(raw.protect, 60)?.toLowerCase();
	const found = roster.find((p) => p.name.toLowerCase() === asked) ?? roster[0];
	return { player: found?.name ?? "", reason: found && found.name.toLowerCase() === asked ? (str(raw.reason, 300) ?? "") : "no readable answer; first player" };
}

/** A lead's steal: a rival's player by name, or none. Players already moved this finale can't be taken. */
export function parseSteal(text: string, targets: Player[]): { player?: string; reason: string; say: string } | { error: string } {
	let raw: Record<string, unknown>;
	try {
		raw = jsonIn(text);
	} catch {
		return { error: `not JSON: ${text.slice(0, 100)}` };
	}
	const reason = str(raw.reason, 300) ?? "";
	const say = str(raw.say, 300) ?? "";
	if (raw.steal === null || raw.steal === undefined || raw.steal === "" || raw.steal === "none") return { reason, say };
	const asked = str(raw.steal, 60)?.toLowerCase();
	const found = targets.find((p) => p.name.toLowerCase() === asked);
	if (!found) return { error: `"${String(raw.steal)}" is not a player you can steal (${targets.map((p) => p.name).join(", ")}), or null` };
	return { player: found.name, reason, say };
}

/**
 * A steal, applied: blocked if the player is protected (the steal is lost). Otherwise the player joins the
 * thief, and the thief's own player in that seat is released to the free agents. Mutates `players`.
 */
export function applySteal(players: Player[], thief: string, name: string, protectedNames: string[]) {
	const target = players.find((p) => p.name === name);
	if (!target || !target.team || target.team === thief) return { outcome: "invalid" as const };
	if (protectedNames.includes(name)) return { outcome: "blocked" as const, from: target.team };
	const from = target.team;
	const released = players.find((p) => p.team === thief && p.seat === target.seat);
	if (released) delete released.team;
	target.team = thief;
	return { outcome: "stolen" as const, from, released };
}

/** An entrant's draft: one free agent per seat, by name; seats with nobody free are left open. */
export function parseEntrantDraft(text: string, free: Player[]): { picks: Partial<Record<Seat, string>>; reason: string; say: string } {
	let raw: Record<string, unknown> = {};
	try {
		raw = jsonIn(text);
	} catch {
		// falls back to the first free player per seat
	}
	const picks: Partial<Record<Seat, string>> = {};
	for (const seat of SEATS) {
		const options = free.filter((p) => p.seat === seat);
		const asked = str(raw[seat], 60)?.toLowerCase();
		const found = options.find((p) => p.name.toLowerCase() === asked) ?? options[0];
		if (found) picks[seat] = found.name;
	}
	return { picks, reason: str(raw.reason, 300) ?? "", say: str(raw.say, 300) ?? "" };
}

// ── Backstory ──────────────────────────────────────────────────────────────────────────────────────

/** What every character knows coming in: the show's story so far, and each team's own. */
export interface Backstory {
	show: string;
	teams: Record<string, string>;
}

const ordinal = (n: number) => ["first", "second", "third", "fourth", "fifth", "sixth"][n - 1] ?? `#${n}`;

/**
 * The story from a previous season's results: who won, every team's places and points, and for each team
 * this season its own line (champion, runner-up, ..., or new this season). `notes` (the producer's own
 * words) close the show's story.
 */
export function backstoryOf(
	prev: { title: string; teams: { team: string; lead?: string }[]; results: { round: number; ranking: { team: string; disqualified?: string }[] }[] } | undefined,
	teams: { team: string; lead?: string }[],
	label: (lead?: string) => string,
	notes?: string,
): Backstory | undefined {
	if (!prev?.results.length && !notes) return undefined;
	const lines: string[] = [];
	const own: Record<string, string> = {};
	if (prev?.results.length) {
		const rounds = [...prev.results].sort((a, b) => a.round - b.round);
		const record = prev.teams.map((t) => {
			const places = rounds.map((r) => r.ranking.findIndex((x) => x.team === t.team) + 1);
			const points = rounds.reduce((sum, r, i) => sum + (r.ranking[places[i] - 1]?.disqualified ? 0 : (PLACE_POINTS[places[i] - 1] ?? 0)), 0);
			return { ...t, places, points };
		});
		record.sort((a, b) => b.points - a.points);
		const who = (t: { team: string; lead?: string }) => `${t.team} (led by ${label(t.lead)})`;
		const champ = record[0];
		const sweep = champ.places.every((p) => p === 1);
		lines.push(
			`${prev.title}: ${record.length} teams, ${rounds.length} rounds. ${who(champ)} won${sweep ? " every round and" : ""} the season with ${champ.points} points; then ${record
				.slice(1)
				.map((t) => `${who(t)} ${t.points}`)
				.join(", ")}.`,
		);
		const returning = new Set(teams.map((t) => t.team));
		const gone = record.filter((t) => !returning.has(t.team));
		for (const t of teams) {
			const r = record.find((x) => x.team === t.team);
			if (!r) {
				own[t.team] = `Your team is new this season${gone.length ? `, in the seat of ${gone.map((g) => g.team).join(" and ")}, which didn't return after ${prev.title}` : ""}. Nobody has seen you play.`;
				continue;
			}
			const place = record.indexOf(r) + 1;
			const finish = place === 1 ? `the reigning champions of ${prev.title}` : `${ordinal(place)} of ${record.length} in ${prev.title}`;
			own[t.team] = `Your team is ${finish}: ${r.points} points, placed ${r.places.map(ordinal).join(" then ")} in its rounds. Every other team knows it.`;
		}
	}
	if (notes?.trim()) lines.push(notes.trim());
	return { show: lines.join(" "), teams: own };
}

/** A lead's story: its team's line, then the show's. */
export const storyFor = (b: Backstory | undefined, team?: string) => (b ? [team ? b.teams[team] : undefined, b.show].filter(Boolean).join(" ") : "");

/** Why a season's format can't run, if it can't. */
export function badFormat(f: Format, cast: boolean, rounds: number): string | undefined {
	if (!cast) return "a format needs a cast season (cast: true)";
	if (f.twist_round !== undefined && (!Number.isInteger(f.twist_round) || f.twist_round < 2 || f.twist_round > rounds)) return `twist_round must be a round from 2 to ${rounds}`;
	if (f.eliminate !== undefined && ![0, 1, 2].includes(f.eliminate)) return "eliminate must be 0, 1 or 2";
	if (f.entrant && f.entrant.kind !== "wildcard" && f.entrant.kind !== "returning") return 'entrant.kind must be "wildcard" or "returning"';
	if (f.entrant?.kind === "returning" && !f.eliminate) return "a returning lead needs an elimination";
	if (f.entrant?.kind === "wildcard" && !(f.entrant.lead in MENU.llm)) return `no model "${f.entrant.lead}" for the wildcard`;
	return undefined;
}
